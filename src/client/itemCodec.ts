/**
 * 物品序列化（M5 步骤 5，llse 完整 NBT 双向）。
 *
 * 存储格式（JSON 串）：
 *   { v: 1, type, count, name?, nbt? }
 * - nbt 存在 = 完整保真：encode 用 item.getNBT().toSNBT()；decode 用 NBTCompound.fromSNBT(snbt)
 *   → new Item(compound)（fromSNBT/toSNBT 已由开发者在 llse 实现）。
 * - nbt 缺失（兼容早期过渡存储的旧数据）：降级为 type/count/name 还原。
 *
 * 注意：本模块**静态 import NBT**（Item.getNBT / NBTCompound.fromSNBT/toSNBT），仅兼容
 * 有完整 NBT 实现的平台（llse）。nodejs 平台已临时下线（其 LNSDK 无 NBT 模块），
 * 详见 AGENTS.md 顶部"临时措施"横幅——不要再用动态 import 等方式为 nodejs 绕错。
 */

import { FMPNBTCompound } from "../../lib/Game/NBT.js";
import { Item, Logger, NBTCompound } from "../../lib/index.js";

export interface ItemPayload {
    v: 1;
    type: string;
    count: number;
    name: string | null;
    /** 完整 NBT 的 SNBT；缺省表示早期过渡存储的数据 */
    nbt?: string;
}

function basePayloadOf(item: Item): ItemPayload {
    return {
        v: 1,
        type: item.type,
        count: item.count,
        name: item.name === undefined || item.name === null ? null : item.name
    };
}

export function encodeItem(item: Item): string {
    const payload = basePayloadOf(item)
    try {
        const snbt = (item.getNBT() as FMPNBTCompound).toSNBT()
        if (typeof snbt === "string" && snbt.length > 0) payload.nbt = snbt
    } catch (e) {
        // toSNBT 异常属平台异常：降级为过渡字段并告警（正常情况不应发生）
        Logger.warn("物品 toSNBT 失败，降级存储（type=" + payload.type + "）：" +
            (e instanceof Error ? e.message : String(e)))
    }
    return JSON.stringify(payload)
}

function parsePayload(serialized: string): ItemPayload | undefined {
    try {
        const parsed = JSON.parse(serialized) as Partial<ItemPayload>
        if (parsed.v !== 1 || typeof parsed.type !== "string" || parsed.type.length === 0) return undefined
        const count = typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : 1
        return {
            v: 1,
            type: parsed.type,
            count,
            name: typeof parsed.name === "string" ? parsed.name : null,
            nbt: typeof parsed.nbt === "string" && parsed.nbt.length > 0 ? parsed.nbt : undefined
        }
    } catch {
        return undefined
    }
}

/** 还原为可 give 的物品：优先完整 NBT，旧过渡数据/解析失败则降级 type/count/name */
export function decodeToItem(serialized: string): Item | undefined {
    const payload = parsePayload(serialized)
    if (payload === undefined) return undefined
    if (payload.nbt !== undefined) {
        try {
            const compound = NBTCompound.fromSNBT(payload.nbt)
            return new Item(compound)
        } catch (e) {
            Logger.warn("物品 SNBT 还原失败，降级为 type/count/name：" +
                (e instanceof Error ? e.message : String(e)))
        }
    }
    return new Item(payload.type, payload.count, payload.name === null ? undefined : payload.name)
}

/** 供表单按钮显示（优先自定义名/type） */
export function decodeLabel(serialized: string): string {
    const payload = parsePayload(serialized)
    if (payload === undefined) return "(无法识别的物品)"
    const display = payload.name !== null && payload.name.length > 0 ? payload.name : payload.type
    return display + " ×" + payload.count
}
