/**
 * 通信协议——消息层（纯 TS，无任何平台/库依赖）。
 *
 * 分工：帧层（frame.ts）只负责把字节流切成"JSON 字符串帧"；本文件定义帧内 JSON 的
 * 信封结构、Phase 1 消息集与构造辅助。业务模块不直接拼接 JSON。
 *
 * 信封（Envelope）字段：
 * - v     协议版本（PROTOCOL_VERSION）
 * - kind  req（上行请求/下行请求）/ rsp（对应响应）/ evt（服务端主动事件）
 * - type  消息类型名（hello/ping/echo/……后续业务消息继续扩展）
 * - id    关联 id：req 与对应 rsp 相同；evt 为 0
 * - t     发送方本地时间戳（ms）
 * - payload 消息体：各类型自定；响应的 payload 统一为 ResponsePayload
 */

export const PROTOCOL_VERSION = 1;

export const KIND_REQUEST = "req";
export const KIND_RESPONSE = "rsp";
export const KIND_EVENT = "evt";

/** Phase 1 消息集 */
export const MSG_HELLO = "hello"; // 客户端认证握手
export const MSG_PING = "ping";   // 心跳请求/响应
export const MSG_ECHO = "echo";   // 通用往返消息（验证双向通信，占位后续业务 RPC）

/** MVP 业务消息集（M4） */
export const MSG_CONTAINER_OPEN = "container.open"; // 打开容器（不存在则自动创建并返回其内容）
export const MSG_CONTAINER_PUT = "container.put";   // 放入一件物品
export const MSG_CONTAINER_TAKE = "container.take"; // 取出（删除）一件物品并取回其序列化串
export const MSG_CONTAINER_ADMIN_DELETE = "container.adminDelete"; // 管理员删除指定容器（跨服/远程）

/** 帧内容的最外层结构 */
export interface Envelope {
    v: number;
    kind: string;
    type: string;
    id: number;
    t: number;
    payload: unknown;
}

/** 所有请求/指令的统一响应体（放在 rsp 信封的 payload 上） */
export interface ResponsePayload {
    ok: boolean;
    data?: unknown;
    reason?: string;
}

export interface HelloRequestPayload {
    token: string;
    /** 客户端上报自己的版本号，便于服务端兼容判断 */
    version?: string;
}

export interface HelloResponseData {
    /** 该连接注册的服务器名：中心服按 token 从 servers{name:token} 反查 */
    serverName: string;
    protocol: number;
}

export interface PingPayload {
    ts: number;
}

export interface EchoPayload {
    text: string;
}

// —— MVP 业务消息载荷（M4）——
// 说明：item 一律为"客户端序列化串"（不透明），服务端只负责存取与排序、不解析其内容；
// 具体序列化格式由 M5 客户端（llse 侧）确定并保证可还原。

/** 容器物品列表项（open 返回） */
export interface ContainerItemDto {
    id: string;
    /** 客户端序列化后的物品串 */
    item: string;
}

export interface ContainerOpenRequestPayload {
    /** 操作所代表的玩家（MVP：由客户端如实上报，服务端信任；鉴权强化见 Phase 7） */
    playerUuid: string;
}

export interface ContainerOpenResponseData {
    containerId: string;
    items: ContainerItemDto[];
}

export interface ContainerPutRequestPayload {
    playerUuid: string;
    /** 客户端序列化后的物品串 */
    item: string;
}

export interface ContainerPutResponseData {
    itemId: string;
}

export interface ContainerTakeRequestPayload {
    playerUuid: string;
    itemId: string;
}

export interface ContainerTakeResponseData {
    /** 取出的物品序列化串（客户端据此还原并 give） */
    item: string;
}

export interface ContainerAdminDeleteRequestPayload {
    /** 发起删除的管理员玩家 uuid（MVP：客户端已判 isOp，服务端信任） */
    playerUuid: string;
    /** 目标容器 uuid */
    containerId: string;
}

export interface ContainerAdminDeleteResponseData {
    containerId: string;
}

let nextId = 0;

/** 生成递增关联 id（同进程内自增即可，TCP 保证顺序与一一对应） */
export function newMessageId(): number {
    nextId += 1;
    if (nextId >= 0x7fffffff) nextId = 1;
    return nextId;
}

export function makeRequest(type: string, payload: unknown, id?: number): Envelope {
    return {
        v: PROTOCOL_VERSION,
        kind: KIND_REQUEST,
        type,
        id: id === undefined ? newMessageId() : id,
        t: Date.now(),
        payload
    };
}

/** 构造对 req 的响应（rsp 信封，type 与 req 一致，id 回填 req.id） */
export function makeResponse(req: Envelope, payload: ResponsePayload): Envelope {
    return {
        v: PROTOCOL_VERSION,
        kind: KIND_RESPONSE,
        type: req.type,
        id: req.id,
        t: Date.now(),
        payload
    };
}

export function okPayload(data?: unknown): ResponsePayload {
    return { ok: true, data };
}

export function failPayload(reason: string): ResponsePayload {
    return { ok: false, reason };
}

/** 最小信封校验：通过基本结构检查才交给上层处理 */
export function isEnvelope(value: unknown): value is Envelope {
    if (typeof value !== "object" || value === null) return false;
    const e = value as Record<string, unknown>;
    return typeof e.v === "number" &&
        typeof e.kind === "string" &&
        typeof e.type === "string" &&
        typeof e.id === "number";
}
