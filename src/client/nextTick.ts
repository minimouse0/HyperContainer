/**
 * 下个游戏 Tick 执行（Defer/NextTick）——开发者提供的"双缓冲三层"极简调度。
 *
 * 原理（按开发者伪代码原样实现）：
 * - taskBuffers 外层固定 3 个数组（下标 0/1/2），内层是待执行函数。
 * - 入队下标 = (-state) + 1：state= 1 → 0；state=-1 → 2（动态映射，无分支）。
 * - 每个 Tick 先翻转 state，再清算下标 (-state)+1 对应的缓冲；清算后 length=0 复用数组。
 *
 * 用途：丢物事件在"游戏逻辑对背包落子"之前触发，我们需在"本 tick 结束/下 tick 开始"
 * 这一区间再读背包做差分——即把回调注册到下一个 tick。
 */

import { TickEvent } from "../../lib/index.js";

// 双缓冲外层数组（0/1/2），内层为任务函数数组
const taskBuffers: Array<Array<() => void>> = [[], [], []];

// 翻转状态量，初始为 1
let state = 1;

/** 将 handler 调度到"本 tick 结束、下个 tick"执行 */
export function nextTick(handler: () => void): void {
    // 根据当前 state 动态计算入队索引，无需任何 if/else 条件判断
    const targetIndex = (-state) + 1;
    taskBuffers[targetIndex].push(handler);
}

// 每个游戏 tick 清算一次
TickEvent.on(() => {
    // 步骤 A：状态取反 (1 <-> -1)
    state = -state;

    // 步骤 B：计算当前需要清算的缓冲下标
    const currentIndex = (-state) + 1;
    const currentBuffer = taskBuffers[currentIndex];

    // 步骤 C：依次执行当前缓冲区中的所有回调
    for (const handler of currentBuffer) {
        handler();
    }

    // 步骤 D：清空当前缓冲区，复用原数组避免 GC
    currentBuffer.length = 0;
    return true;
});
