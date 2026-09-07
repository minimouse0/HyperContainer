/**
 * 客户端连接器（Connector）：面向中心服的单条长连接状态机。
 *
 * 职责（仅 Phase 1 范围内的连接层，业务转发/指令等由后续阶段接入）：
 *   - TCP 连接（契约 TCPConnect）+ 帧级收发（transport/connection）
 *   - hello 认证握手：token → 认证通过进入 connected / 失败停止（不无限重连）
 *   - 心跳：周期发送 ping，按"下行数据静默时长"判定链路失效
 *   - 断线自动重连：指数退避，认证成功后退避计数归零
 *   - 通用 request()：按关联 id 匹配响应（后续业务 RPC 复用此通道）
 *
 * 事件为单处理器 setter（与满月契约惯例一致）：赋值即覆盖。
 */

import { Logger, TCPConnect } from "../../lib/index.js";

import { Connection } from "../transport/connection.js";
import {
    KIND_RESPONSE,
    MSG_HELLO,
    MSG_PING,
    makeRequest
} from "../protocol/messages.js";
import type { Envelope, ResponsePayload } from "../protocol/messages.js";

export type ConnectorState = "idle" | "connecting" | "connected" | "stopping" | "stopped";

export interface ConnectorConfig {
    host: string;
    port: number;
    token: string;
    /** 心跳周期 */
    heartbeatIntervalMs?: number;
    /** 超过该时长收不到任何下行数据（如 pong）则判定链路失效并重连 */
    watchdogTimeoutMs?: number;
    /** 重连退避起点与上限（指数：base, 2×base, …，封顶 max） */
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
    type: string;
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class Connector {
    readonly config: ConnectorConfig;
    private readonly heartbeatIntervalMs: number;
    private readonly watchdogTimeoutMs: number;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;

    private currentState: ConnectorState = "idle";
    private conn: Connection | undefined;
    private stopped = false;
    private authFailed = false;
    private awaitingHello = false;
    private reconnectAttempts = 0;
    private lastDataAt = 0;

    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private watchdogTimer: ReturnType<typeof setInterval> | undefined;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pending = new Map<number, PendingRequest>();

    /** 认证通过、进入 connected 时触发（重连成功后也会再次触发） */
    onReady?: () => void;
    onStateChange?: (state: ConnectorState) => void;
    /** 服务端主动下发、且不在请求响应关联表里的消息（如后续下行指令/事件） */
    onMessage?: (message: Envelope) => void;
    onError?: (err: Error) => void;

    constructor(config: ConnectorConfig) {
        this.config = config;
        this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;
        this.reconnectBaseMs = config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    }

    get state(): ConnectorState {
        return this.currentState;
    }

    private setState(state: ConnectorState): void {
        if (this.currentState !== state) {
            this.currentState = state;
            this.onStateChange?.(state);
        }
    }

    /** 启动连接。stop() 之后可再次 start()；已运行时重复调用会被忽略 */
    start(): void {
        if (this.state === "connecting" || this.state === "connected") return;
        this.stopped = false;
        this.authFailed = false;
        this.reconnectAttempts = 0;
        this.pending.forEach((req) => req.reject(new Error("连接器已重启，请求取消")));
        this.pending.clear();
        this.connectNow();
    }

    /** 优雅停止：不再重连，关闭当前连接并拒绝所有在途请求 */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clearTimers();
        this.rejectAllPending("连接器已停止");
        if (this.conn !== undefined) {
            this.conn.end();
            this.conn = undefined;
        }
        this.setState("stopped");
    }

    private clearTimers(): void {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.watchdogTimer !== undefined) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private rejectAllPending(reason: string): void {
        if (this.pending.size > 0) {
            const types = Array.from(this.pending.values()).map((req) => req.type).join(",");
            Logger.warn("清空 " + this.pending.size + " 个在途请求（" + types + "）：" + reason);
        }
        this.pending.forEach((req) => {
            clearTimeout(req.timer);
            req.reject(new Error(reason));
        });
        this.pending.clear();
    }

    /**
     * 发起一个请求并等待响应（按 id 关联）。
     * 返回 rsp.payload.data；服务端回 ok:false 或以 reason 拒绝时抛错。
     */
    request(type: string, payload?: unknown, timeoutMs?: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (this.state !== "connected" || this.conn === undefined) {
                reject(new Error("未连接（state=" + this.state + "）"));
                return;
            }
            const message = makeRequest(type, payload);
            const timer = setTimeout(() => {
                this.pending.delete(message.id);
                reject(new Error("请求超时：" + type));
            }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
            this.pending.set(message.id, { type, resolve, reject, timer });
            this.conn.send(message);
        });
    }

    // ---------- 内部：连接建立与重连 ----------

    private connectNow(): void {
        if (this.stopped) return;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.setState("connecting");

        const socket = TCPConnect(this.config.port, this.config.host);
        const conn = new Connection(socket, {
            onConnect: () => {
                this.lastDataAt = Date.now();
                this.sendHello();
            },
            onMessage: (message) => this.handleMessage(message),
            onClose: (hadError) => this.handleClose(hadError),
            onError: (err) => this.handleError(err)
        });
        this.conn = conn;
    }

    private sendHello(): void {
        if (this.conn === undefined) return;
        this.awaitingHello = true;
        this.conn.send(makeRequest(MSG_HELLO, { token: this.config.token }));
    }

    private handleMessage(message: Envelope): void {
        this.lastDataAt = Date.now();

        // 等待 hello 响应阶段
        if (this.awaitingHello) {
            if (message.kind === KIND_RESPONSE && message.type === MSG_HELLO) {
                const payload = message.payload as ResponsePayload;
                this.awaitingHello = false;
                if (payload.ok === true) {
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    this.setState("connected");
                    this.onReady?.();
                } else {
                    const reason = payload.reason || "unknown reason";
                    Logger.error("认证被拒绝（" + reason + "），停止重连。");
                    this.authFailed = true;
                    this.stop();
                    this.onError?.(new Error("AUTH_FAILED: " + reason));
                }
            }
            return;
        }

        if (this.state !== "connected") return;

        // 关联请求-响应
        if (message.kind === KIND_RESPONSE && this.pending.has(message.id)) {
            const req = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            clearTimeout(req.timer);
            const payload = message.payload as ResponsePayload;
            if (payload.ok === true) req.resolve(payload.data);
            else req.reject(new Error("请求失败（" + message.type + "）：" + (payload.reason || "unknown")));
            return;
        }

        // 其余下行消息交回调
        this.onMessage?.(message);
    }

    private handleClose(_hadError: boolean): void {
        this.stopHeartbeat();
        if (this.conn !== undefined) this.conn = undefined;
        this.awaitingHello = false;
        if (this.stopped) return;
        this.rejectAllPending("连接已断开");
        this.scheduleReconnect();
    }

    private handleError(err: any): void {
        if (this.stopped) return;
        Logger.warn("连接器错误 remote=" + this.config.host + ":" + this.config.port +
            "：" + (err instanceof Error ? err.message : String(err)));
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.authFailed) return;
        const delay = Math.min(
            this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts),
            this.reconnectMaxMs
        );
        this.reconnectAttempts += 1;
        Logger.info("连接断开，" + delay + "ms 后重连（第 " + this.reconnectAttempts + " 次）");
        this.setState("connecting");
        this.reconnectTimer = setTimeout(() => this.connectNow(), delay);
    }

    // ---------- 心跳与看门狗 ----------

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.state === "connected" && this.conn !== undefined) {
                this.conn.send(makeRequest(MSG_PING, { ts: Date.now() }));
            }
        }, this.heartbeatIntervalMs);
        this.watchdogTimer = setInterval(() => {
            if (this.state !== "connected") return;
            const silent = Date.now() - this.lastDataAt;
            if (silent > this.watchdogTimeoutMs) {
                Logger.warn("链路静默 " + silent + "ms，判定失效，强制重连");
                this.conn?.destroy(); // onClose 会触发重连
            }
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.watchdogTimer !== undefined) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
    }
}
