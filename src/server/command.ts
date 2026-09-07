/**
 * 服务端命令贡献（full build 由命令聚合处注册；client-only 不会包含本模块）。
 * 本文件不构造 Command（构造即注册）；只导出贡献清单供 src/command/contrib.ts 聚合。
 *
 * 分支（均消费后返回 true）：
 *   - restart：重载插件（仅服务端有；客户端无此命令）
 *   - containers delete <uuid>：管理员删除容器
 */

import {
    CommandEnum,
    CommandEnumOptions,
    CommandParam,
    CommandParamDataType,
    CommandParamType,
    CommandResult,
    CommandExecutor,
    Player
} from "../../lib/index.js";
import { restartPlugin } from "../index.js";
import { listenInit } from "./events.js";
import { deleteContainer, getContainerById, getPlayerUuidOfContainer, uuid2name } from "./db.js";
import type { CommandContribution } from "../command/contrib.js";

export const serverCommandContribution: CommandContribution = {
    name: "hypercontainer",
    params: [
        new CommandParam(CommandParamType.Mandatory, "restart", CommandParamDataType.Enum, new CommandEnum("restart", ["restart"]), CommandEnumOptions.Unfold),
        new CommandParam(CommandParamType.Mandatory, "containers", CommandParamDataType.Enum, new CommandEnum("containers", ["containers"]), CommandEnumOptions.Unfold),
        new CommandParam(CommandParamType.Mandatory, "deleteEnum", CommandParamDataType.Enum, new CommandEnum("deleteEnum", ["delete"]), CommandEnumOptions.Unfold),
        new CommandParam(CommandParamType.Mandatory, "uuid", CommandParamDataType.String)
    ],
    overloads: [
        [],
        ["restart"],
        ["containers", "deleteEnum", "uuid"]
    ],
    registerPositions: { operator: true, console: true, anyPlayer: true },
    handler: (result: CommandResult): boolean | void => {
        if (result.params.get("restart")?.value === "restart") {
            listenInit(restartPlugin)
            return true
        }
        if (result.params.get("deleteEnum")?.value === "delete") {
            handleAdminDelete(result)
            return true
        }
        return false
    }
}

/**
 * 管理员删除：/hypercontainer containers delete <uuid>
 * 权限：console/插件内部视为管理员；玩家需 isOp（MVP 取巧：管理判定在 llse 侧、
 * 同进程直连 DB；跨服 client-only 场景的管理 RPC 化留待 M5/Phase 7）。
 */
function handleAdminDelete(result: CommandResult) {
    const uuid = result.params.get("uuid")?.value
    listenInit(async () => {
        try {
            if (typeof uuid !== "string" || uuid.length === 0) {
                result.executor.sendError("缺少容器 uuid")
                return
            }
            if (!isAdministrator(result.executor)) {
                result.executor.sendError("无权限：仅管理员可删除容器")
                return
            }
            const container = getContainerById(uuid)
            if (container === undefined) {
                result.executor.sendError("容器不存在：" + uuid)
                return
            }
            const owner = getPlayerUuidOfContainer(uuid)
            const ownerName = owner === undefined ? undefined : uuid2name(owner)
            deleteContainer(uuid)
            const suffix = ownerName !== undefined ? "（归属玩家 " + ownerName + "）" : ""
            result.executor.sendSuccess("已删除容器 " + uuid + suffix)
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            result.executor.sendError("删除容器失败：" + message)
        }
    })
}

/** console / 插件内部等非玩家执行者视为管理员；玩家则必须 isOp */
function isAdministrator(executor: CommandExecutor): boolean {
    const player = Player.from(executor)
    if (player === undefined) return true
    return player.isOp()
}
