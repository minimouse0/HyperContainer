/**
 * 传输层连接封装：把契约 TCPSocket（字节流）提升为"帧级连接"。
 * 接入连接（服务端）与出站连接（客户端）共用本类。
 *
 * 本文件对 lib 只做 type-only import，编译后不含 lib 运行时依赖，可独立用于测试；
 * 真正的 TCPSocket 实例由上层（central/connector）用契约 API 创建后传入。
 */

import type { TCPSocket } from "../../lib/index.js";

import { encodeFrame, FrameDecoder } from "../protocol/frame.js";
import { isEnvelope } from "../protocol/messages.js";
import type { Envelope } from "../protocol/messages.js";

export interface ConnectionHandlers {
    onMessage: (message: Envelope) => void;
    onClose: (hadError: boolean) => void;
    onError: (err: any) => void;
    /** 仅出站连接会触发（TCP 建立成功） */
    onConnect?: () => void;
}

export class Connection {
    readonly remoteAddress: string | undefined;
    readonly remotePort: number | undefined;

    private readonly decoder = new FrameDecoder();
    private readonly socket: TCPSocket;
    private readonly handlers: ConnectionHandlers;

    constructor(socket: TCPSocket, handlers: ConnectionHandlers) {
        this.socket = socket;
        this.handlers = handlers;
        this.remoteAddress = socket.remoteAddress;
        this.remotePort = socket.remotePort;

        socket.onData = (data: Buffer) => this.handleData(data);
        socket.onClose = (hadError: boolean) => handlers.onClose(hadError);
        socket.onError = (err: any) => handlers.onError(err);
        if (handlers.onConnect !== undefined) socket.onConnect = handlers.onConnect;
    }

    private handleData(data: Buffer): void {
        let frames: unknown[];
        try {
            frames = this.decoder.push(data);
        } catch (e) {
            this.handlers.onError(e);
            this.socket.destroy();
            return;
        }
        for (const frame of frames) {
            if (isEnvelope(frame)) this.handlers.onMessage(frame);
            // 结构非法的帧静默丢弃（同端只应运行本协议）
        }
    }

    /** 发送一帧。返回契约 write 的返回值（false 仅表示进入本端缓冲，非发送失败） */
    send(message: Envelope): boolean {
        try {
            return this.socket.write(encodeFrame(message));
        } catch (e) {
            this.handlers.onError(e);
            return false;
        }
    }

    /** 优雅关闭：冲刷已写数据后发送 FIN */
    end(): void {
        this.socket.end();
    }

    /** 立即销毁底层连接（触发 onClose） */
    destroy(): void {
        this.socket.destroy();
    }

    get destroyed(): boolean {
        return this.socket.destroyed;
    }
}
