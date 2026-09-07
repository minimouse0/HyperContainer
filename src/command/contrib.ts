/**
 * 命令"贡献清单 + 单次聚合注册"机制（开发者定案，2026-09-04）。
 *
 * 背景：客户端与服务端可能同进程共存（full build），而 `/hypercontainer` 只需注册一次。
 * 解法：任何一方都不在模块顶层构造 Command（构造即注册，会撞名），而是导出"贡献清单"
 * （参数对象 / 重载表 / 注册位置 / 回调）。真正构造 Command 只发生一次：
 *   - full build：由服务端聚合 [客户端清单, 服务端清单] 后构造；回调先执行客户端 handler，
 *     客户端返回 true 表示"已消费、阻止服务端处理器"，false/void 则继续跑服务端 handler。
 *   - client-only：客户端自行用 [客户端清单] 构造（restart 等仅在服务端清单里，不会出现）。
 *
 * 注意：CommandParam/CommandEnum 等"参数对象"的构造本身不会注册，可安全在清单中预构造。
 */

import { Command, CommandEnum, CommandEnumOptions, CommandParam, CommandParamDataType, CommandParamType, CommandResult, Logger } from "../../lib/index.js";

export interface CommandRegisterPositions {
    operator?: boolean;
    console?: boolean;
    internal?: boolean;
    anyPlayer?: boolean;
}

export interface CommandContribution {
    /** 命令名（合并时要求各贡献同名，如 hypercontainer） */
    name: string;
    /** 该贡献要用到的参数对象（按参数名去重合并） */
    params: CommandParam[];
    /** 重载表：每行为一个重载（参数名序列，空行表示无参用法） */
    overloads: string[][];
    registerPositions: CommandRegisterPositions;
    /**
     * 命令回调。
     * 返回 true 表示该贡献已消费本次命令（阻止后续贡献的处理器执行）；
     * 返回 false/void 表示让后续处理器（如服务端的 restart/delete）继续。
     * client-only 单独运行时返回值无意义（后面没有其他处理器）。
     */
    handler: (result: CommandResult) => boolean | void;
}

export interface MergedCommand {
    params: CommandParam[];
    overloads: string[][];
    registerPositions: CommandRegisterPositions;
}

/** 合并多份贡献：参数按名字去重（先到先得）；重载行去重；注册位置取并集 */
export function mergeContributions(contributions: CommandContribution[]): MergedCommand {
    const paramByName = new Map<string, CommandParam>();
    for (const contribution of contributions) {
        for (const param of contribution.params) {
            if (!paramByName.has(param.name)) paramByName.set(param.name, param);
        }
    }
    const overloads: string[][] = [];
    const seenRows = new Set<string>();
    for (const contribution of contributions) {
        for (const row of contribution.overloads) {
            const key = JSON.stringify(row);
            if (!seenRows.has(key)) {
                seenRows.add(key);
                overloads.push(row);
            }
        }
    }
    const registerPositions: CommandRegisterPositions = {};
    for (const contribution of contributions) {
        Object.assign(registerPositions, contribution.registerPositions);
    }
    return { params: Array.from(paramByName.values()), overloads, registerPositions };
}

/** 依序执行各贡献的 handler，任一返回 true 即停止；全部未消费则执行 fallback */
export function composeHandler(
    contributions: CommandContribution[],
    fallback?: (result: CommandResult) => void
): (result: CommandResult) => void {
    return (result) => {
        for (const contribution of contributions) {
            if (contribution.handler(result) === true) return;
        }
        if (fallback !== undefined) fallback(result);
    };
}

/**
 * 构造并注册命令（构造即注册，同一进程对一个命令名只能调用一次）。
 * @param contributions 执行顺序：数组前面的 handler 先执行（如 full build 传 [client, server]）
 */
export function registerContributedCommand(
    contributions: CommandContribution[],
    fallback?: (result: CommandResult) => void
): void {
    if (contributions.length === 0) throw new Error("registerContributedCommand: 贡献列表不能为空");
    const merged = mergeContributions(contributions);
    new Command(
        contributions[0].name,
        merged.params,
        merged.overloads,
        composeHandler(contributions, fallback),
        merged.registerPositions
    );
}
