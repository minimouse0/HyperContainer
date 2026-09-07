/**
 * MVP 容器业务 RPC 处理器（M4）。
 * 每个函数接收 (ctx, 参数字段...) 并返回统一 ResponsePayload；由 central 的消息分发调用。
 * 数据读写全部走 server/db.ts 的 DAO；访问判定统一走 access.checkContainerAccess。
 *
 * 注意：MVP 以"操作所代表的玩家 uuid"解析其唯一容器（open 自动创建），
 * 因而只能操作本人容器；服务端信任客户端上报的 playerUuid（明文无鉴权，Phase 7 强化）。
 */

import { failPayload, okPayload } from "../protocol/messages.js";
import type { ResponsePayload } from "../protocol/messages.js";

import { checkContainerAccess } from "./access.js";
import {
    appendContainerItem,
    deleteContainer,
    ensurePlayerContainer,
    getContainerById,
    getContainerItemById,
    getContainerOfPlayer,
    listContainerItems,
    removeContainerItemById
} from "./db.js";

export interface RpcContext {
    /** 发起请求的服务器（来自已认证连接） */
    serverId: string;
    /** 操作所代表的玩家 */
    playerUuid: string;
}

/** 打开（首次即自动创建）自己的容器并返回其内容 */
export function openContainer(ctx: RpcContext): ResponsePayload {
    const container = ensurePlayerContainer(ctx.playerUuid);
    const items = listContainerItems(container.id).map((row) => ({ id: row.id, item: row.item }));
    return okPayload({ containerId: container.id, items });
}

/** 向自己的容器放入一件物品 */
export function putItem(ctx: RpcContext, item: string): ResponsePayload {
    if (typeof item !== "string" || item.length === 0) {
        return failPayload("物品数据为空");
    }
    const container = getContainerOfPlayer(ctx.playerUuid);
    if (container === undefined) {
        return failPayload("容器不存在，请先打开容器");
    }
    const access = checkContainerAccess(ctx.playerUuid, ctx.serverId, container.id);
    if (!access.allowed) return failPayload(access.reason ?? "无权操作");
    const row = appendContainerItem(container.id, item);
    return okPayload({ itemId: row.id });
}

/** 从自己的容器取出一件物品（删除行并返回其序列化串供客户端 give） */
export function takeItem(ctx: RpcContext, itemId: string): ResponsePayload {
    if (typeof itemId !== "string" || itemId.length === 0) {
        return failPayload("缺少物品 id");
    }
    const container = getContainerOfPlayer(ctx.playerUuid);
    if (container === undefined) {
        return failPayload("容器不存在，请先打开容器");
    }
    const access = checkContainerAccess(ctx.playerUuid, ctx.serverId, container.id);
    if (!access.allowed) return failPayload(access.reason ?? "无权操作");

    const row = getContainerItemById(itemId);
    if (row === undefined || row.containerId !== container.id) {
        return failPayload("该物品不存在于你的容器");
    }
    removeContainerItemById(itemId);
    return okPayload({ item: row.item });
}

/**
 * 管理员删除容器（跨服/远程，container.adminDelete）。
 * MVP 取舍：客户端侧已判 isOp，服务端信任该判定（明文无鉴权，Phase 7 补强）。
 */
export function adminDeleteContainer(_ctx: RpcContext, containerId: string): ResponsePayload {
    if (typeof containerId !== "string" || containerId.length === 0) {
        return failPayload("缺少容器 id");
    }
    const container = getContainerById(containerId);
    if (container === undefined) {
        return failPayload("容器不存在：" + containerId);
    }
    deleteContainer(containerId);
    return okPayload({ containerId });
}
