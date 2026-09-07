/**
 * 放入表单（替代原丢物放入模式，2026-09-05 开发者定案：纯表单选择物品）。
 *
 * 实机槽位（0-35）：9-35 为物品栏第一、二、三行，0-8 为快捷栏（第四行）。
 * 展示顺序：第一行(9-17) → 第二行(18-26) → 第三行(27-35) → 快捷栏(0-8)。
 *
 * 交互（含开发者改进）：
 *   - 容器主页点「放入物品」→ 行选择页（按钮仅显示 第一行/第二行/第三行/快捷栏；**无返回键**，
 *     因返回主页列表不会自动刷新，故暂去掉该页返回）；
 *   - 点某行 → 该行 9 格列表（按钮仅显示物品名；空格显示"（空格）"）；
 *   - 点某格 → 读该格整叠（完整 NBT 序列化）→ `inventory.removeItem(slot,count)` 整格移除
 *     → 上行 `container.put` 入库；失败用序列化串还原 give 回背包；
 *   - 格页仍保留满月自动返回键（可回到行选择页）。
 */

import { Logger, Player, SimpleForm, SimpleFormButton, SimpleFormSession } from "../../lib/index.js";
import type { CustomFormSession, Item, ModalFormSession } from "../../lib/index.js";

import { MSG_CONTAINER_PUT } from "../protocol/messages.js";

import { getConnector } from "./messenger.js";
import { decodeToItem, encodeItem } from "./itemCodec.js";
import { rejectedItems } from "../server/conf.js";

const SLOTS_PER_ROW = 9

interface RowInfo {
    label: string
    start: number
}

/** 实机布局：9-35 是前三行（物品栏），0-8 是快捷栏 */
const ROW_INFOS: RowInfo[] = [
    { label: "第一行", start: 9 },
    { label: "第二行", start: 18 },
    { label: "第三行", start: 27 },
    { label: "快捷栏", start: 0 }
]

type AnyPreviousSession = SimpleFormSession | CustomFormSession | ModalFormSession | undefined

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

function rowInfoOf(slot: number): RowInfo {
    for (const info of ROW_INFOS) {
        if (slot >= info.start && slot < info.start + SLOTS_PER_ROW) return info
    }
    return ROW_INFOS[3] // 兜底：快捷栏
}

function sendForm(form: SimpleForm, player: Player, lastSession: AnyPreviousSession): void {
    // 满月表单：传上一会话会自动加"返回"键并回到上一级
    if (lastSession !== undefined) new SimpleFormSession(form, lastSession).send()
    else new SimpleFormSession(form, player).send()
}

/** 格按钮文字：只显示物品名；空格显示"（空格）" */
function slotItemLabel(item: Item | undefined): string {
    if (item === undefined) return "（空格）"
    return item.name !== undefined && item.name.length > 0 ? item.name : item.type
}

/** 放入入口（从容器主页点"放入物品"进入）：行选择页不带返回键（返回主页列表不会刷新） */
export function openContainerPutEntry(player: Player): void {
    openPutRowPicker(player)
}

/** 行选择页：第一行/第二行/第三行/快捷栏 */
export function openPutRowPicker(player: Player): void {
    const buttons: SimpleFormButton[] = ROW_INFOS.map((info) => new SimpleFormButton(
        "row-" + info.start,
        info.label,
        (session) => { openPutSlotPage(session.player, info.start, info.label, session) }
    ))
    const form = new SimpleForm("放入物品 · 选择行", "", buttons)
    // 不传 lastSession：该页无返回键
    sendForm(form, player, undefined)
}

/** 某一行最多 9 格；空格与 rejected_items 中的物品不生成按钮 */
export function openPutSlotPage(player: Player, startSlot: number, label: string, lastSession: AnyPreviousSession): void {
    const inventory = player.getInventory()
    const size = Number(inventory.size) || 0
    // 本服禁放物品（版本/addon 不一致时，这类物品不能放进容器以免跨服错乱）
    const rejected = new Set(rejectedItems())
    const buttons: SimpleFormButton[] = []
    for (let i = 0; i < SLOTS_PER_ROW; i++) {
        const slot = startSlot + i
        const item = slot < size ? inventory.getItem(slot) : undefined
        // 空格：不添加按钮；被禁物品（rejected_items.includes(type)）：不添加按钮
        if (item === undefined) continue
        if (rejected.has(item.type)) continue
        buttons.push(new SimpleFormButton(
            "slot-" + slot,
            slotItemLabel(item),
            (session) => { void handlePutSlot(session.player, slot, session) }
        ))
    }
    const form = new SimpleForm("放入物品 · " + label, "", buttons)
    sendForm(form, player, lastSession)
}

/** 整格放入：读取→移除→入库；失败还原 */
async function handlePutSlot(player: Player, slot: number, slotSession: SimpleFormSession): Promise<void> {
    const messenger = getConnector()
    if (messenger === undefined || messenger.state !== "connected") {
        player.tell("容器服务尚未就绪，请稍后再试")
        return
    }
    const inventory = player.getInventory()
    const size = Number(inventory.size) || 0
    if (slot >= size) {
        player.tell("该格不在背包范围内")
        return
    }
    const item = inventory.getItem(slot)
    if (item === undefined) {
        player.tell("该格没有物品")
        return
    }

    // 1) 先序列化（完整 NBT；此处不是丢出事件，读 NBT 安全）
    const serialized = encodeItem(item)
    // 2) 从背包整格移除（FMPPlayerInventory.removeItem 内部会 refreshItems）
    if (!inventory.removeItem(slot, item.count)) {
        player.tell("从背包移除该格物品失败")
        return
    }

    // 3) 入库；失败则用序列化串还原 give 回玩家
    try {
        await messenger.request(MSG_CONTAINER_PUT, { playerUuid: player.uuid, item: serialized })
        player.tell("已放入容器")
    } catch (e) {
        Logger.warn("放入失败，尝试还原物品（slot=" + slot + "）：" + errText(e))
        const restored = decodeToItem(serialized)
        if (restored !== undefined && player.giveItem(restored)) {
            player.tell("放入失败，物品已放回背包")
        } else {
            Logger.error("放入失败且还原失败（slot=" + slot + "），请人工核查该物品")
            player.tell("放入失败且还原失败，请联系管理员")
        }
    }

    // 4) 重开本行列表页以便继续（返回键仍指向上级的行选择页）
    const info = rowInfoOf(slot)
    openPutSlotPage(player, info.start, info.label, slotSession.lastSession)
}
