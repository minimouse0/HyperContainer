import { DisableEvent, InitEvent, Logger } from "../lib/index.js";

import { initConf } from "./server/conf.js";
import { registerContributedCommand } from "./command/contrib.js";
import { clientCommandContribution } from "./client/commands.js";
import { installUnconfiguredNotify, startStandaloneClient, stopClient } from "./client/messenger.js";

/**
 * 客户端入口（client-only 构建的 main 指向本文件；full build 不使用）。
 * 职责：初始化配置 → 标记"独立运行"→ 注册玩家命令（含远程管理删除）→ 连接远程中心服；
 * token 未配置时给出日志 + isOp 进服提示，不启动连接。
 */

let booted = false;

InitEvent.on(() => {
    if (booted) return true
    booted = true
    const doInit = async () => {
        try {
            await initConf()
            // client-only：不是被服务端带起，标记为独立运行（命令的删除分支将走 RPC）
            installUnconfiguredNotify()
            await startStandaloneClient()
            // 注册 /hypercontainer（玩家表单 + containers delete）
            registerContributedCommand([clientCommandContribution], (result) => {
                result.executor.sendSuccess("该用法尚未实现。")
            })
            Logger.info("HyperContainer client-only 初始化完成。")
        } catch (e) {
            Logger.error("HyperContainer client-only 初始化失败：" +
                (e instanceof Error ? e.message : String(e)))
        }
    }
    void doInit()
    return true
})

// 卸载/重载时主动断开连接，避免旧连接残留在中心服（配合中心服的"顶替旧连接"重连机制）
DisableEvent.on(() => {
    stopClient()
    return true
})
