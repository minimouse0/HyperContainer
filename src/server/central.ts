/**
 * 中心服核心：TCP 监听、认证握手、连接注册表与心跳清扫。
 *
 * 每个接入连接的处理流程：
 *   1. 建连 → 放入"待认证"集合，等待 hello；
 *   2. hello 携带 token → 查 TokenRegistry：
 *       - token 非法   → 回 fail 并优雅关闭；
 *       - serverId 重复（已有活跃连接）→ 回 fail 并关闭新连接；
 *       - 通过         → 登记进 ConnectionRegistry，回 ok（内含 serverId）；
 *   3. 已认证连接上收到的消息按类型分发（ping→pong、echo→回显、其余→fail）。
 *
 * 本模块只做 Phase 1 的"连接与会话"，业务命令分发（RPC handler 表）属于 Phase 4。
 */

import { Logger, TCPServer } from "../../lib/index.js";
import type { TCPSocket } from "../../lib/index.js";

import { Connection } from "../transport/connection.js";
import {
    KIND_REQUEST,
    MSG_CONTAINER_ADMIN_DELETE,
    MSG_CONTAINER_OPEN,
    MSG_CONTAINER_PUT,
    MSG_CONTAINER_TAKE,
    MSG_ECHO,
    MSG_HELLO,
    MSG_PING,
    PROTOCOL_VERSION,
    failPayload,
    makeResponse,
    okPayload
} from "../protocol/messages.js";
import type { Envelope, ResponsePayload } from "../protocol/messages.js";

import { adminDeleteContainer, openContainer, putItem, takeItem } from "./containerRpc.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import { TokenRegistry } from "./tokenRegistry.js";
import type { CentralServerConfig } from "./conf.js";


export let central: CentralServerHandle | undefined;

export interface CentralServerHandle {
    /** 停止监听并断开所有连接 */
    stop(): Promise<void>;
    /** 断开指定 serverId 的活跃连接（模拟掉线/踢出）；返回是否存在该连接 */
    kick(serverId: string): boolean;
    /** 当前已认证的 serverId 列表 */
    listClients(): string[];
    readonly port: number;
}

const SWEEP_INTERVAL_MS = 10_000;

function remoteOf(address: string | undefined, port: number | undefined): string {
    return (address || "?") + ":" + (port ?? "?");
}

function readString(body: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = body?.[key];
    return typeof value === "string" ? value : undefined;
}

export async function startCentralServer(config: CentralServerConfig): Promise<void> {
    const tokens = new TokenRegistry(config.credentials);
    const registry = new ConnectionRegistry();
    const authedServerIdByConn = new Map<Connection, string>();
    const pendingHellos = new Set<Connection>();
    const helloTimers = new Map<Connection, ReturnType<typeof setTimeout>>();

    let sweepTimer: ReturnType<typeof setInterval> | undefined;

    function reply(conn: Connection, req: Envelope, payload: ResponsePayload): void {
        conn.send(makeResponse(req, payload));
    }

    function drop(conn: Connection): void {
        // 主动断开：立即摘除注册，避免重连握手撞上"重复 serverId"
        const serverId = authedServerIdByConn.get(conn);
        if (serverId !== undefined) {
            registry.remove(serverId);
            authedServerIdByConn.delete(conn);
        }
        pendingHellos.delete(conn);
        conn.destroy();
    }

    function cleanup(conn: Connection): void {
        const serverId = authedServerIdByConn.get(conn);
        if (serverId !== undefined) {
            authedServerIdByConn.delete(conn);
            registry.remove(serverId);
            Logger.info("客户端连接关闭：server=" + serverId + " remote=" + remoteOf(conn.remoteAddress, conn.remotePort));
        }
        pendingHellos.delete(conn);
        const timer = helloTimers.get(conn);
        if (timer !== undefined) {
            clearTimeout(timer);
            helloTimers.delete(conn);
        }
    }

    function handleMessage(conn: Connection, message: Envelope): void {
        const now = Date.now();
        const serverId = authedServerIdByConn.get(conn);

        // ---- 未认证：只接受 hello ----
        if (serverId === undefined) {
            if (message.kind !== KIND_REQUEST || message.type !== MSG_HELLO) {
                reply(conn, message, failPayload("尚未认证，请先发送 hello"));
                conn.end();
                return;
            }
            const payload = (typeof message.payload === "object" && message.payload !== null)
                ? message.payload as { token?: unknown }
                : undefined;
            // 以 token 反查服务器名（servers{name:token} 双向表）
            const serverName: string | undefined = tokens.nameOfToken(payload?.token);
            if (serverName === undefined) {
                reply(conn, message, failPayload("invalid token"));
                Logger.warn("握手被拒：无效 token，remote=" + remoteOf(conn.remoteAddress, conn.remotePort));
                conn.end();
                return;
            }
            if (registry.get(serverName) !== undefined) {
                // 同 token 的新连接到来（典型场景：插件热重载后旧连接尚未清理）：
                // 顶替旧连接而非拒绝新连接，保证重连即时成功。
                const stale = registry.get(serverName)!;
                registry.remove(serverName);
                authedServerIdByConn.delete(stale.connection);
                Logger.warn("server=" + serverName + " 已有活跃连接，新连接顶替（可能是热重载重连）");
                stale.connection.destroy(); // 触发旧端 close → cleanup 幂等
            }
            const registered = registry.register({
                serverId: serverName,
                name: serverName,
                connection: conn,
                authedAt: now,
                lastSeen: now,
                remote: remoteOf(conn.remoteAddress, conn.remotePort)
            });
            if (!registered) {
                reply(conn, message, failPayload("register failed"));
                conn.end();
                return;
            }
            authedServerIdByConn.set(conn, serverName);
            pendingHellos.delete(conn);
            reply(conn, message, okPayload({
                serverName,
                protocol: PROTOCOL_VERSION
            }));
            Logger.info("客户端已认证注册：server=" + serverName +
                " remote=" + remoteOf(conn.remoteAddress, conn.remotePort));
            return;
        }

        // ---- 已认证：心跳保活 + 消息分发（MVP M4 起为最小 RPC 分发表） ----
        registry.touch(serverId, now);
        const body = (typeof message.payload === "object" && message.payload !== null)
            ? message.payload as Record<string, unknown> : undefined;
        switch (message.type) {
            case MSG_PING:
                reply(conn, message, okPayload({ ts: typeof body?.ts === "number" ? body.ts : undefined }));
                return;
            case MSG_ECHO:
                reply(conn, message, okPayload({ text: typeof body?.text === "string" ? body.text : undefined }));
                return;
            case MSG_CONTAINER_OPEN:
            case MSG_CONTAINER_PUT:
            case MSG_CONTAINER_TAKE: {
                const playerUuid = readString(body, "playerUuid");
                if (playerUuid === undefined) {
                    reply(conn, message, failPayload("缺少 playerUuid"));
                    return;
                }
                const ctx = { serverId, playerUuid };
                if (message.type === MSG_CONTAINER_OPEN) {
                    reply(conn, message, openContainer(ctx));
                } else if (message.type === MSG_CONTAINER_PUT) {
                    const item = readString(body, "item");
                    if (item === undefined) {
                        reply(conn, message, failPayload("缺少 item"));
                        return;
                    }
                    reply(conn, message, putItem(ctx, item));
                } else {
                    const itemId = readString(body, "itemId");
                    if (itemId === undefined) {
                        reply(conn, message, failPayload("缺少 itemId"));
                        return;
                    }
                    reply(conn, message, takeItem(ctx, itemId));
                }
                return;
            }
            case MSG_CONTAINER_ADMIN_DELETE: {
                const playerUuid = readString(body, "playerUuid");
                const containerId = readString(body, "containerId");
                if (playerUuid === undefined || containerId === undefined) {
                    reply(conn, message, failPayload("缺少 playerUuid 或 containerId"));
                    return;
                }
                reply(conn, message, adminDeleteContainer({ serverId, playerUuid }, containerId));
                return;
            }
            default:
                reply(conn, message, failPayload("unknown message type: " + message.type));
        }
    }

    function sweepIdleClients(): void {
        const now = Date.now();
        for (const client of registry.all) {
            if (now - client.lastSeen > config.idleTimeoutMs) {
                Logger.warn("心跳超时，断开失联客户端：server=" + client.serverId +
                    " idleMs=" + (now - client.lastSeen));
                drop(client.connection);
            }
        }
    }

    const server = new TCPServer(config.port, (socket: TCPSocket) => {
        const conn = new Connection(socket, {
            onMessage: (message) => handleMessage(conn, message),
            onClose: (hadError) => {
                if (hadError) {
                    const id = authedServerIdByConn.get(conn);
                    Logger.warn("连接异常关闭" + (id !== undefined ? "：server=" + id : "") +
                        " remote=" + remoteOf(conn.remoteAddress, conn.remotePort));
                }
                cleanup(conn);
            },
            onError: (err) => {
                Logger.error("连接出错 remote=" + remoteOf(conn.remoteAddress, conn.remotePort) +
                    "：" + (err instanceof Error ? err.message : String(err)));
            }
        });
        pendingHellos.add(conn);
        const timer = setTimeout(() => {
            if (pendingHellos.has(conn)) {
                Logger.warn("握手超时，断开未认证连接：remote=" + remoteOf(conn.remoteAddress, conn.remotePort));
                conn.end();
            }
        }, config.helloTimeoutMs);
        helloTimers.set(conn, timer);
    }, config.host);

    try {
        await server.start();
    } catch (e) {
        throw new Error("中心服监听失败（端口 " + config.port + "）：" +
            (e instanceof Error ? e.message : String(e)));
    }

    sweepTimer = setInterval(sweepIdleClients, SWEEP_INTERVAL_MS);
    Logger.info("中心服已监听：host=" + (config.host || "*") + " port=" + server.port +
        " 注册令牌数=" + tokens.size);

    central= {
        get port() {
            return server.port;
        },
        kick(serverId: string): boolean {
            const client = registry.get(serverId);
            if (client === undefined) return false;
            Logger.info("踢出客户端：server=" + serverId);
            drop(client.connection);
            return true;
        },
        listClients(): string[] {
            return registry.all.map((client) => client.serverId);
        },
        async stop(): Promise<void> {
            if (sweepTimer !== undefined) {
                clearInterval(sweepTimer);
                sweepTimer = undefined;
            }
            for (const conn of Array.from(authedServerIdByConn.keys())) drop(conn);
            for (const conn of Array.from(pendingHellos)) {
                clearTimeout(helloTimers.get(conn));
                helloTimers.delete(conn);
                conn.destroy();
            }
            pendingHellos.clear();
            await server.stop();
            Logger.info("中心服已停止");
        }
    };
}

export async function stopCentralServer() {
    if (central === undefined) return;
    const handle = central;
    central = undefined;
    try {
        // 真正等到底层 server.stop() 完成，端口释放后再返回（reload/重启依赖此语义）
        await handle.stop();
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        Logger.error("HyperContainer 停止中心服出错：" + message);
    }
}