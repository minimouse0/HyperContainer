/**
 * 中心服侧：已认证客户端连接注册表。
 * 每个 serverId 只允许一条活跃连接；重复连接在认证握手时被服务端拒绝。
 */

import type { Connection } from "../transport/connection.js";

export interface RegisteredClient {
    serverId: string;
    name?: string;
    connection: Connection;
    authedAt: number;
    /** 最近一次收到该客户端帧的时间（心跳保活判定依据） */
    lastSeen: number;
    remote: string;
}

export class ConnectionRegistry {
    private readonly byServerId = new Map<string, RegisteredClient>();

    /** 注册；若该 serverId 已有活跃连接则返回 false（不覆盖） */
    register(client: RegisteredClient): boolean {
        if (this.byServerId.has(client.serverId)) return false;
        this.byServerId.set(client.serverId, client);
        return true;
    }

    get(serverId: string): RegisteredClient | undefined {
        return this.byServerId.get(serverId);
    }

    remove(serverId: string): RegisteredClient | undefined {
        const client = this.byServerId.get(serverId);
        if (client !== undefined) this.byServerId.delete(serverId);
        return client;
    }

    touch(serverId: string, now: number): void {
        const client = this.byServerId.get(serverId);
        if (client !== undefined) client.lastSeen = now;
    }

    /** 快照：所有活跃客户端 */
    get all(): RegisteredClient[] {
        return Array.from(this.byServerId.values());
    }

    get size(): number {
        return this.byServerId.size;
    }
}
