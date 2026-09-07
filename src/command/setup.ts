/**
 * full build 的命令聚合入口：把客户端与服务端的命令贡献合成"一个"命令注册。
 *
 * 执行顺序 = 数组顺序：客户端 handler 先执行（无参→开表单），返回 true 则阻止服务端
 * 处理器；否则服务端 handler 处理 restart/containers delete；都未消费则兜底提示。
 * client-only（单独运行）不经过本模块，由客户端自行注册（见 src/client.ts 后续接线）。
 */

import { Logger, type CommandResult } from "../../lib/index.js";

import { clientCommandContribution } from "../client/commands.js";
import { serverCommandContribution } from "../server/command.js";
import { registerContributedCommand } from "./contrib.js";

export function registerFullBuildCommands(): void {
    registerContributedCommand(
        [clientCommandContribution, serverCommandContribution],
        (result: CommandResult) => {
            result.executor.sendSuccess("该用法尚未实现。")
        }
    )
}
