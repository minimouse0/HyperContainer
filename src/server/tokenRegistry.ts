/**
 * 服务器令牌注册表：servers{name: token} 的双向映射。
 * - 连接时以 token（右值）反查服务器名 name（左值）；
 * - name 与 token 均须唯一：构造时若 name 重复（Map 覆盖）或 token 重复（TwoWayMap）都会抛错。
 */

import { TwoWayMap } from "../../lib/index.js";

import type { ServerCredential } from "./conf.js";

export class TokenRegistry {
    private readonly map: TwoWayMap<string, string>

    constructor(credentials: ServerCredential[]) {
        const data = new Map<string, string>()
        for (const credential of credentials) {
            data.set(credential.name, credential.token)
        }
        if (data.size !== credentials.length) {
            throw new Error("servers 配置中 name 存在重复")
        }
        // TwoWayMap 构造时校验右侧（token）不重复
        this.map = new TwoWayMap(data)
    }

    /** token → 服务器名；未登记返回 undefined */
    nameOfToken(token: unknown): string | undefined {
        if (typeof token !== "string") return undefined
        return this.map.toLeft(token)
    }

    get size(): number {
        return this.map.leftTable.size
    }
}
