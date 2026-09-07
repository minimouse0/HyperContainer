/**
 * 容器访问判定（MVP 统一入口 / 未来权限组模块的注入点）。
 *
 * 当前实现：仅"容器所属玩家本人"可访问（查 player_container_map），
 * serverId 暂不参与判断（任意服务器可访问）。
 *
 * ⚠️ 后续替换为 Permission 模块调用时，只需改本文件的实现，调用方不变。
 */

import { isOwnerOfContainer } from "./db.js";

export interface AccessResult {
    allowed: boolean;
    /** 拒绝原因（allowed=false 时给出） */
    reason?: string;
}

export function checkContainerAccess(playerUuid: string, _serverId: string, containerId: string): AccessResult {
    // TODO(权限组)：此处替换为 Permission 模块的带 context 判定
    if (!isOwnerOfContainer(playerUuid, containerId)) {
        return { allowed: false, reason: "你无权访问该容器" };
    }
    return { allowed: true };
}
