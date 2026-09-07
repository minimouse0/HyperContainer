/**
 * 客户端命令贡献。
 *
 * 分支：
 *   - 无参：玩家打开容器表单（always 本客户端处理）。
 *   - `containers delete <uuid>`（管理员）：
 *       · 内嵌（被服务端带起，full build）：return false 交服务端本地删除分支处理；
 *       · client-only 独立运行：本客户端走 container.adminDelete RPC 到中心服。
 *
 * 参数/枚举名沿用了 `deleteEnum`（BDS 会把枚举参数名 `delete` 强制改写，见 AGENTS 记录）。
 */

import {
    CommandEnum,
    CommandEnumOptions,
    CommandParam,
    CommandParamDataType,
    CommandParamType,
    CommandResult,
    Player
} from "../../lib/index.js";

import type { CommandContribution } from "../command/contrib.js";
import { MSG_CONTAINER_ADMIN_DELETE } from "../protocol/messages.js";

import { openContainerForm } from "./forms.js";
import { getConnector, isEmbeddedMode } from "./messenger.js";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

export const clientCommandContribution: CommandContribution = {
    name: "hypercontainer",
    params: [
        new CommandParam(CommandParamType.Mandatory, "containers", CommandParamDataType.Enum, new CommandEnum("containers", ["containers"]), CommandEnumOptions.Unfold),
        new CommandParam(CommandParamType.Mandatory, "deleteEnum", CommandParamDataType.Enum, new CommandEnum("deleteEnum", ["delete"]), CommandEnumOptions.Unfold),
        new CommandParam(CommandParamType.Mandatory, "uuid", CommandParamDataType.String)
    ],
    overloads: [
        [],
        ["containers", "deleteEnum", "uuid"]
    ],
    registerPositions: { operator: true, console: true, anyPlayer: true },
    handler: (result: CommandResult): boolean | void => {
        // 只消费"无参"分支（玩家打开容器表单）
        if (result.params.size === 0) {
            const player = Player.from(result.executor)
            if (player === undefined) {
                result.executor.sendError("请以玩家身份执行该命令")
                return true
            }
            try {
                void openContainerForm(player)
            } catch (e) {
                result.executor.sendError("打开容器失败：" + errText(e))
            }
            return true
        }

        // 管理员删除分支
        if (result.params.get("deleteEnum")?.value === "delete") {
            if (isEmbeddedMode()) return false // 内嵌：交服务端本地 handler
            void handleStandaloneAdminDelete(result)
            return true
        }

        return false // 其余参数组合交后续处理器/兜底
    }
}

/** client-only 独立运行：管理删除经 RPC 到中心服（isOp 判定在 llse 侧，MVP 明文信任） */
async function handleStandaloneAdminDelete(result: CommandResult): Promise<void> {
    const uuid = result.params.get("uuid")?.value
    if (typeof uuid !== "string" || uuid.length === 0) {
        result.executor.sendError("缺少容器 uuid")
        return
    }
    const player = Player.from(result.executor)
    const isAdmin = player === undefined ? true : player.isOp()
    if (!isAdmin) {
        result.executor.sendError("无权限：仅管理员可删除容器")
        return
    }
    const messenger = getConnector()
    if (messenger === undefined || messenger.state !== "connected") {
        result.executor.sendError("尚未连接中心服，请稍后再试")
        return
    }
    try {
        await messenger.request(MSG_CONTAINER_ADMIN_DELETE, {
            playerUuid: player !== undefined ? player.uuid : "console",
            containerId: uuid
        })
        result.executor.sendSuccess("已删除容器 " + uuid)
    } catch (e) {
        result.executor.sendError("删除容器失败：" + errText(e))
    }
}
