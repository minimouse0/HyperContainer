import { Player, SQLDataType, SQLDataTypeEnum, SQLite3, newUUID4 } from "../../lib/index.js";
import {data_path} from "../../lib/plugin_info.js"

export const db=new SQLite3(data_path+"/data.db")

db.initTable("player_info",{
    name:"uuid",
    data_type:new SQLDataType(SQLDataTypeEnum.TEXT),
    constraint:{
        primary_key:true
    }
},{
    name:"xuid",
    data_type:new SQLDataType(SQLDataTypeEnum.TEXT)
},{
    name:"name",
    data_type:new SQLDataType(SQLDataTypeEnum.TEXT)
})


export function name2uuid(name:string):string|undefined{

    const uuidQueryResult=db.queryAllSync("SELECT uuid FROM player_info WHERE name=?",name)
    if(uuidQueryResult[0]==undefined){
        return undefined;
    }
    return uuidQueryResult[0].uuid
}
export function uuid2name(uuid:string):string|undefined{

    const nameQueryResult=db.queryAllSync("SELECT name FROM player_info WHERE uuid=?",uuid)
    if(nameQueryResult[0]==undefined){
        return undefined;
    }
    return nameQueryResult[0].name
}
export function xuid2uuid(xuid:string):string|undefined{

    const uuidQueryResult=db.queryAllSync("SELECT uuid FROM player_info WHERE xuid=?",xuid)
    if(uuidQueryResult[0]==undefined){
        return undefined;
    }
    return uuidQueryResult[0].uuid
}
export function uuid2xuid(uuid:string):string|undefined{

    const xuidQueryResult=db.queryAllSync("SELECT xuid FROM player_info WHERE uuid=?",uuid)
    if(xuidQueryResult[0]==undefined){
        return undefined;
    }
    return xuidQueryResult[0].xuid
}
export function xuid2name(xuid:string):string|undefined{

    const nameQueryResult=db.queryAllSync("SELECT name FROM player_info WHERE xuid=?",xuid)
    if(nameQueryResult[0]==undefined){
        return undefined;
    }
    return nameQueryResult[0].name
}

// ================= 容器表与 DAO（MVP M2，2026-09-04） =================
// 临时 schema：containers 暂不含 owner 列与权限节点列（后续经 newColumn/ALTER 添加）；
// 归属关系用 player_container_map（玩家↔容器 一对一）表达。
// DAO 优先使用满月 SQLite3 遗留 DAO（initTable/setRow/setRowFromPrimaryKey/
// getRowFromPrimaryKey）；按非主键的查询与级联删除等 DAO 无法表达的操作用 runSync/
// queryAllSync 执行原始 SQL。

export interface ContainerRecord {
    id: string
    name: string | null
    createdAt: number
}
export interface PlayerContainerRecord {
    playerUuid: string
    containerId: string
    createdAt: number
}
export interface ContainerItemRecord {
    id: string
    containerId: string
    item: string
    createdAt: number
}

db.initTable("containers", {
    name: "id",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT),
    constraint: {
        primary_key: true
    }
}, {
    name: "name",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT)
}, {
    name: "created_at",
    data_type: new SQLDataType(SQLDataTypeEnum.INTEGER)
})

db.initTable("player_container_map", {
    name: "player_uuid",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT),
    constraint: {
        primary_key: true
    }
}, {
    name: "container_id",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT),
    constraint: {
        unique: true
    }
}, {
    name: "created_at",
    data_type: new SQLDataType(SQLDataTypeEnum.INTEGER)
})

db.initTable("container_items", {
    name: "id",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT),
    constraint: {
        primary_key: true
    }
}, {
    name: "container_id",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT)
}, {
    name: "item",
    data_type: new SQLDataType(SQLDataTypeEnum.TEXT)
}, {
    name: "created_at",
    data_type: new SQLDataType(SQLDataTypeEnum.INTEGER)
})

/** getRowFromPrimaryKey 返回的 Map → 业务对象 */
function rowMapToRecord<T>(map: Map<string, any>): T | undefined {
    if (map.size === 0) return undefined
    const record: any = {}
    map.forEach((value, key) => { record[key] = value })
    return record as T
}

function toContainerRecord(raw: any): ContainerRecord {
    return {
        id: raw.id,
        name: raw.name === undefined || raw.name === null ? null : raw.name,
        createdAt: raw.created_at
    }
}

function toPlayerContainerRecord(raw: any): PlayerContainerRecord {
    return {
        playerUuid: raw.player_uuid,
        containerId: raw.container_id,
        createdAt: raw.created_at
    }
}

function toContainerItemRecord(raw: any): ContainerItemRecord {
    return {
        id: raw.id,
        containerId: raw.container_id,
        item: raw.item,
        createdAt: raw.created_at
    }
}

export function getContainerById(containerId: string): ContainerRecord | undefined {
    const raw = rowMapToRecord<any>(db.getRowFromPrimaryKey("containers", containerId))
    return raw === undefined ? undefined : toContainerRecord(raw)
}

/** 查询玩家当前绑定的容器（无则 undefined） */
export function getPlayerContainer(playerUuid: string): PlayerContainerRecord | undefined {
    const raw = rowMapToRecord<any>(db.getRowFromPrimaryKey("player_container_map", playerUuid))
    return raw === undefined ? undefined : toPlayerContainerRecord(raw)
}

/** 按容器反向查询其当前归属玩家（player_container_map 的 container_id 唯一） */
export function getPlayerUuidOfContainer(containerId: string): string | undefined {
    const rows: any[] = db.queryAllSync(
        "SELECT player_uuid FROM player_container_map WHERE container_id=?",
        containerId)
    return rows[0] === undefined ? undefined : rows[0].player_uuid
}

/** 查询玩家当前绑定的容器行 */
export function getContainerOfPlayer(playerUuid: string): ContainerRecord | undefined {
    const bind = getPlayerContainer(playerUuid)
    if (bind === undefined) return undefined
    return getContainerById(bind.containerId)
}

/**
 * 确保玩家拥有唯一容器：存在则直接返回，不存在则创建容器 + 归属映射。
 * 若发现"映射残留但容器已不存在"（例如曾被管理员删除）会先清理映射再重建，
 * 维持"每玩家恒有一容器"的不变量。
 */
export function ensurePlayerContainer(playerUuid: string): ContainerRecord {
    const bind = getPlayerContainer(playerUuid)
    if (bind !== undefined) {
        const container = getContainerById(bind.containerId)
        if (container !== undefined) return container
        // 容器已不在（被删除），清掉残留映射后重建
        db.runSync("DELETE FROM player_container_map WHERE container_id=? OR player_uuid=?",
            bind.containerId, playerUuid)
    }
    const id = newUUID4()
    const createdAt = Date.now()
    db.setRow("containers", { columnName: "id", value: id },
        { columnName: "name", value: null },
        { columnName: "created_at", value: createdAt })
    db.setRow("player_container_map", { columnName: "player_uuid", value: playerUuid },
        { columnName: "container_id", value: id },
        { columnName: "created_at", value: createdAt })
    return { id, name: null, createdAt }
}

/** 判定玩家是否为该容器的归属玩家（MVP 权限检查的唯一依据；后续替换为权限组模块） */
export function isOwnerOfContainer(playerUuid: string, containerId: string): boolean {
    const bind = getPlayerContainer(playerUuid)
    return bind !== undefined && bind.containerId === containerId
}

/** 删除容器：级联删除其物品与归属映射（无 PK 语义的批量删除，DAO 无法表达，用裸 SQL） */
export function deleteContainer(containerId: string): void {
    db.runSync("DELETE FROM container_items WHERE container_id=?", containerId)
    db.runSync("DELETE FROM player_container_map WHERE container_id=?", containerId)
    db.runSync("DELETE FROM containers WHERE id=?", containerId)
}

/** 列出容器内全部物品（按放入时间排序） */
export function listContainerItems(containerId: string): ContainerItemRecord[] {
    const rows: any[] = db.queryAllSync(
        "SELECT id,container_id,item,created_at FROM container_items WHERE container_id=? ORDER BY created_at ASC,id ASC",
        containerId)
    return rows.map((row) => toContainerItemRecord(row))
}

/** 往容器追加一件物品（item 为客户端序列化后的字符串，格式由客户端决定） */
export function appendContainerItem(containerId: string, item: string): ContainerItemRecord {
    const id = newUUID4()
    const createdAt = Date.now()
    db.setRow("container_items", { columnName: "id", value: id },
        { columnName: "container_id", value: containerId },
        { columnName: "item", value: item },
        { columnName: "created_at", value: createdAt })
    return { id, containerId, item, createdAt }
}

export function getContainerItemById(itemId: string): ContainerItemRecord | undefined {
    const raw = rowMapToRecord<any>(db.getRowFromPrimaryKey("container_items", itemId))
    return raw === undefined ? undefined : toContainerItemRecord(raw)
}

/** 取出物品：按物品 id 删除 */
export function removeContainerItemById(itemId: string): void {
    db.runSync("DELETE FROM container_items WHERE id=?", itemId)
}