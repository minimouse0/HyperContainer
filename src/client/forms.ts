/**
 * 玩家容器表单（一体式 SimpleForm 主页）。
 *
 * 交互（开发者定稿 + 2026-09-05 调整）：
 *   - 顶部：物品按钮列表（点击 = 取出并自动重开刷新）
 *   - 底部功能按钮：刷新 / 放入物品（进入纯表单选格放入，见 putForm.ts）
 *
 * 本模块仅在 llse（真机）上有实际 UI 效果；nodejs 平台不会触发。
 */

import { Logger, Player, SimpleForm, SimpleFormButton, SimpleFormSession } from "../../lib/index.js";
import { MSG_CONTAINER_OPEN, MSG_CONTAINER_PUT, MSG_CONTAINER_TAKE } from "../protocol/messages.js";
import type { ContainerItemDto } from "../protocol/messages.js";

import { getConnector } from "./messenger.js";
import { decodeLabel, decodeToItem } from "./itemCodec.js";
import { openContainerPutEntry } from "./putForm.js";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

/** 打开该玩家的容器主页（服务端不存在则自动创建） */
export async function openContainerForm(player: Player): Promise<void> {
    const messenger = getConnector()
    if (messenger === undefined || messenger.state !== "connected") {
        player.tell("容器服务尚未就绪，请稍后再试")
        return
    }
    const playerUuid = player.uuid
    let opened: any
    try {
        opened = await messenger.request(MSG_CONTAINER_OPEN, { playerUuid })
    } catch (e) {
        player.tell("打开容器失败：" + errText(e))
        return
    }
    const items: ContainerItemDto[] = opened.items as ContainerItemDto[]

    // 临时"容器已满"判断：容器里已有 9 份物品即视为满。
    // TODO(正式 Phase 3 限制/Slots 完全体)：届时按容器容量上限、剩余可放数量与
    // 物品可堆叠性等规则判断"还能不能放得下"，替换此处写死的数量判断。
    const CONTAINER_MAX_ITEMS_TEMP = 9
    const putDisabled = items.length >= CONTAINER_MAX_ITEMS_TEMP

    const buttons: SimpleFormButton[] = items.map((entry) => new SimpleFormButton(
        "item-" + entry.id,
        decodeLabel(entry.item),
        (session) => { void takeAndGive(session.player, playerUuid, entry.id) }
    ))
    buttons.push(new SimpleFormButton("refresh", "刷新", (session) => { void openContainerForm(session.player) }))
    if (putDisabled) {
        // 已满：按钮仅提示，点击无动作
        buttons.push(new SimpleFormButton("put", "（背包已满）", () => { /* 无动作 */ }))
    } else {
        buttons.push(new SimpleFormButton(
            "put",
            "放入物品",
            (session) => { openContainerPutEntry(session.player) }
        ))
    }

    const form = new SimpleForm("你的容器", "共 " + items.length + " 件物品", buttons)
    new SimpleFormSession(form, player).send()
}

/** 取出：服务端出库 → give 玩家 → 成功后重开表单刷新；give 失败则回存容器 */
async function takeAndGive(player: Player, playerUuid: string, itemId: string): Promise<void> {
    const messenger = getConnector()
    if (messenger === undefined || messenger.state !== "connected") {
        player.tell("容器服务尚未就绪，请稍后再试")
        return
    }
    let taken: any
    try {
        taken = await messenger.request(MSG_CONTAINER_TAKE, { playerUuid, itemId })
    } catch (e) {
        player.tell("取出失败：" + errText(e))
        return
    }
    const serialized: string = taken.item
    const item = decodeToItem(serialized)
    if (item === undefined) {
        // 已从服务端删除但本端无法还原：尽力回存并提示（正常不应发生）
        Logger.error("取出物品无法解析（itemId=" + itemId + "），尝试回存。")
        try {
            await messenger.request(MSG_CONTAINER_PUT, { playerUuid, item: serialized })
            player.tell("取出失败：物品数据无法解析，已放回容器")
        } catch {
            player.tell("取出失败且放回失败，请联系管理员")
        }
        return
    }
    if (!player.giveItem(item)) {
        // 背包满等：回存
        try {
            await messenger.request(MSG_CONTAINER_PUT, { playerUuid, item: serialized })
            player.tell("背包空间不足，物品已放回容器")
        } catch {
            player.tell("背包空间不足且放回失败，请联系管理员")
        }
        return
    }
    void openContainerForm(player)
}
