/**
 * 通信协议——帧层（纯 TS，无任何平台/库依赖）。
 *
 * 满月契约 TCP API 面向字节流：onData 可能分块到达、也可能一次粘到多个报文，契约
 * 不做任何协议层处理。本模块负责编码与切帧：
 *   帧 = 4 字节大端长度前缀 + UTF-8 JSON 载荷
 * 单帧载荷上限 FRAME_MAX_BYTES，超过时抛错，由上层决定断开连接。
 */

export const FRAME_MAX_BYTES = 8 * 1024 * 1024;

const LENGTH_BYTES = 4;

export function encodeFrame(message: unknown): Buffer {
    const json = JSON.stringify(message);
    const body = Buffer.from(json, "utf8");
    if (body.length > FRAME_MAX_BYTES) {
        throw new Error("帧载荷超过上限 " + FRAME_MAX_BYTES + " 字节");
    }
    const header = Buffer.alloc(LENGTH_BYTES);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

/** 把一段字节流切成一帧帧的解析器（每个连接持有一个实例） */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    /**
     * 吞入一段收到的字节，返回本次解析出的完整帧数组。
     * 若遇到超限帧或非法 JSON，抛错；由上层销毁该连接。
     */
    push(chunk: Buffer): unknown[] {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const frames: unknown[] = [];
        for (;;) {
            if (this.buffer.length < LENGTH_BYTES) break;
            const length = this.buffer.readUInt32BE(0);
            if (length > FRAME_MAX_BYTES) {
                throw new Error("收到超限帧：" + length + " 字节");
            }
            if (this.buffer.length < LENGTH_BYTES + length) break; // 半包，等后续数据
            const body = this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
            frames.push(JSON.parse(body.toString("utf8")));
            this.buffer = this.buffer.subarray(LENGTH_BYTES + length);
        }
        return frames;
    }

    /** 尚未凑成完整帧的缓冲字节数（供日志/诊断） */
    get bufferedBytes(): number {
        return this.buffer.length;
    }
}
