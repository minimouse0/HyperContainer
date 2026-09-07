import { File, YMLFile, newUUID4 } from "../../lib/index.js";
import { data_path } from "../../lib/plugin_info.js";

export let conf: YMLFile;
export async function initConf() {
    conf = await YMLFile.create(data_path + "/config.yml");
    await conf.init("api_port", 18362);
    await conf.init("enable_api", false);
    await conf.init("DLSAPI", {});
    const DLSAPIConfig = await YMLFile.create(data_path + "/config.yml", ["DLSAPI"]);
    await DLSAPIConfig.init("host", "");
    await DLSAPIConfig.init("port", 0);
    await DLSAPIConfig.init("token", "");

    // ---- 连接中心服（客户端侧只读这两项）----
    await conf.init("central_host", "localhost");
    await conf.init("token", "");

    // ---- 禁止放入容器的物品类型（各客户端自行配置，跨服物品不一致场景用）----
    await conf.init("rejected_items", []);

    // ---- 中心服 TCP 监听 ----
    await conf.init("tcp_port", DEFAULT_TCP_PORT);
    await conf.init("tcp_host", "");

    // ---- 中心服注册表：servers = { name: token }（name/token 均唯一；无旧格式兼容）----
    await conf.init("servers", {});
}

// —— 类型与默认值 ——

export interface ServerCredential {
    /** 服务器名（唯一；供中心服日志/连接注册/未来 context 使用） */
    name: string;
    /** 该服务器持有的令牌（唯一；连接时由 token 反查 name） */
    token: string;
}

export interface CentralServerConfig {
    /** 监听地址；缺省监听所有网卡（TCPServer 语义） */
    host?: string;
    port: number;
    credentials: ServerCredential[];
    /** 已认证客户端超过该时长没有任何下行数据则判定失联并断开 */
    idleTimeoutMs: number;
    /** 建连后等待 hello 握手的最长时长，超时断开 */
    helloTimeoutMs: number;
}

export const DEFAULT_TCP_PORT = 26960;
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** 根级 central_host */
export function centralHost(): string {
    const value = conf.get("central_host")
    return typeof value === "string" && value.length > 0 ? value : "localhost"
}

/** 根级 token（本服客户端令牌；空=未配置） */
export function clientToken(): string {
    const value = conf.get("token")
    return typeof value === "string" ? value : ""
}

/** 禁止放入容器的物品类型列表（各客户端 config 自行维护） */
export function rejectedItems(): string[] {
    const value = conf.get("rejected_items")
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
}

/**
 * "服务端带起的客户端"身份初始化（仅 llse full build 场景调用）：
 * 若 token 为空则生成 uuid 持久化；并确保中心端 servers 含 local: <token>。
 */
export async function ensureEmbeddedIdentity(): Promise<void> {
    let token = clientToken()
    if (token.length === 0) {
        token = newUUID4()
        await conf.set("token", token)
    }
    const rawServers = conf.get("servers")
    const servers: Record<string, string> = {}
    if (rawServers !== null && typeof rawServers === "object" && !Array.isArray(rawServers)) {
        for (const [name, token] of Object.entries(rawServers as Record<string, unknown>)) {
            if (typeof token === "string") servers[name] = token
        }
    }
    if (servers["local"] === undefined) {
        servers["local"] = token
        await conf.set("servers", servers)
    }
}

/** 解析 servers{name:token} 为凭据数组（name/token 唯一性由 TwoWayMap 构造时校验） */
export function centralServerConfig(): CentralServerConfig {
    const hostRaw = conf.get("tcp_host")
    const portRaw = conf.get("tcp_port")
    const serversRaw = conf.get("servers")

    const host = typeof hostRaw === "string" && hostRaw.length > 0 ? hostRaw : undefined
    const port = typeof portRaw === "number" ? portRaw : DEFAULT_TCP_PORT

    const credentials: ServerCredential[] = []
    if (serversRaw !== null && typeof serversRaw === "object" && !Array.isArray(serversRaw)) {
        for (const [name, token] of Object.entries(serversRaw as Record<string, unknown>)) {
            if (typeof token === "string" && token.length > 0 && name.length > 0) {
                credentials.push({ name, token })
            }
        }
    }

    return {
        host,
        port,
        credentials,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        helloTimeoutMs: DEFAULT_HELLO_TIMEOUT_MS
    };
}

/**玩家是否是bds内置权限系统的管理员，此函数可以做到离线查询玩家是否是管理员，而不必等到玩家上线再查询 */
export async function isOpInPermissionsJSON(xuid: string) {
    const currentPermissions: Array<any> = JSON.parse(await File.read("./permissions.json"));
    for (const permission of currentPermissions) {
        if (permission.xuid == xuid) return permission.permission == "operator";
    }
    return false;
}
