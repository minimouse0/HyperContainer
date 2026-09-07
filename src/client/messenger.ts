/**
 * 客户端使者运行时（单例 Connector）。
 *
 * 身份/连接配置（见 conf.ts）：
 *   - 根级 `central_host`（默认 localhost）与 `token`（默认 ""）。
 *   - **内嵌（full build、被服务端带起）**：startEmbeddedClient() 先 ensureEmbeddedIdentity()
 *     （token 为空则生成 uuid 并写入 servers.local），连接 localhost。
 *   - **独立运行（client-only）**：startStandaloneClient() 读 central_host/token 连接远程中心服；
 *     token 为空视为未配置：后台日志 + isOp 进服提示（installUnconfiguredNotify）。
 *
 * 模式标志 isEmbeddedMode()：默认 true（full build）；client-only 在注册命令前 setEmbeddedMode(false)。
 * 命令分支据它决定"内嵌=交服务端本地处理 / 独立=走 RPC"。
 */

import { Logger, PlayerJoinEvent } from "../../lib/index.js";
import { PLATFORM } from "../../lib/plugin_info.js";

import { centralHost, clientToken, conf, ensureEmbeddedIdentity } from "../server/conf.js";
import { Connector } from "./connector.js";

let connector: Connector | undefined;
let embeddedMode = true;
let unconfiguredNotifyInstalled = false;

export function getConnector(): Connector | undefined {
    return connector;
}

/** 是否"被服务端带起"（full build 内嵌）；client-only 单独运行应设为 false */
export function setEmbeddedMode(value: boolean): void {
    embeddedMode = value
}

export function isEmbeddedMode(): boolean {
    return embeddedMode
}

function readCentralPort(): number {
    const raw = conf.get("tcp_port")
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 26960
}

function buildConnector(host: string, token: string): Connector {
    return new Connector({
        host,
        port: readCentralPort(),
        token,
        heartbeatIntervalMs: 8_000,
        watchdogTimeoutMs: 30_000,
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 10_000
    })
}

function attachClient(client: Connector, label: string): void {
    connector = client
    client.onReady = () => {
        Logger.info("客户端已连接中心服：server=" + label + "（" + (embeddedMode ? "内嵌 localhost" : "远程") + "）")
    }
    client.onError = (err) => {
        Logger.warn("客户端连接错误：" + err.message)
    }
    client.start()
}

/** full build（llse）内嵌使者：确保本服身份后连接本地中心服 */
export async function startEmbeddedClient(): Promise<void> {
    if ((PLATFORM as string) !== "llse") {
        Logger.info("当前平台 " + PLATFORM + " 不启动内嵌客户端使者（nodejs 独立中心服模式）。")
        return
    }
    if (connector !== undefined) return
    setEmbeddedMode(true)
    await ensureEmbeddedIdentity()
    const token = clientToken()
    if (token.length === 0) {
        Logger.error("本服 token 为空且无法生成，内嵌客户端无法连接中心服。")
        return
    }
    attachClient(buildConnector("localhost", token), "local")
}

/**
 * client-only（独立运行）入口：连接远程中心服。
 * token 为空 = 未配置 → 后台日志 + isOp 提示，返回 false。
 */
export async function startStandaloneClient(): Promise<boolean> {
    setEmbeddedMode(false)
    if (connector !== undefined) return true
    const token = clientToken()
    if (token.length === 0) {
        Logger.warn("HyperContainer 客户端未配置：config.yml 根级 token 为空（无法连接中心服）。")
        return false
    }
    const host = centralHost()
    attachClient(buildConnector(host, token), token)
    return true
}

/** 停止使者（配合插件 reload/stop 释放连接与定时器） */
function doStopClient(): void {
    const client = connector
    connector = undefined
    if (client !== undefined) client.stop()
}

/** client-only 独立运行时停止使者（DisableEvent/卸载时调用，保证旧连接及时断开） */
export function stopClient(): void {
    doStopClient()
}

/** full build 停止内嵌使者（index.stopPlugin 使用） */
export function stopEmbeddedClient(): void {
    doStopClient()
}

/** 未配置时对 isOp 玩家进服给出提示（仅安装一次） */
export function installUnconfiguredNotify(): void {
    if (unconfiguredNotifyInstalled) return
    unconfiguredNotifyInstalled = true
    PlayerJoinEvent.on((event) => {
        if (clientToken().length === 0 && event.player.isOp()) {
            event.player.tell("HyperContainer 未配置：请在 config.yml 设置 central_host 与 token")
        }
    })
}
