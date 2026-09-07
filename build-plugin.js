#!/usr/bin/env node
/**
 * HyperContainer 插件构建包装脚本（Phase 0 产物）。
 *
 * 用法（在项目根目录执行）：
 *   node build-plugin.js                 # 构建完整版（服务端+客户端合体）
 *   node build-plugin.js --client-only   # 构建仅客户端版
 *
 * 产物目录约定：完整版与仅客户端版的产物"文件夹名"必须一致（同为 plugin_dir_name，
 * 不改动），两者通过不同的输出根目录区分，避免互相覆盖：
 *   完整版     → plugin.json.build_dir（当前为 dist/）
 *   仅客户端版 → client/
 *
 * 行为约定：
 * - 不加参数：本脚本不做任何配置改写，直接调用底层满月平台 builder
 *   （build/build.js，等价于 `node build`），行为与直接运行 `node build` 完全一致，
 *   产物为完整版（plugin.json.main=index），落在 build_dir（dist/）下。
 * - 加 --client-only：临时把 plugin.json.main 切到客户端入口 client、build_dir 改到
 *   client/，再调用底层 builder；无论构建成败都会精确还原 plugin.json，保证不留配置
 *   残留（失败/信号中断路径同样可靠）。
 *
 * 硬性约束：本脚本只读 build/ 而不修改它；不绕过满月 builder 自行调用 tsc。
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const PLUGIN_JSON = path.join(ROOT, "plugin.json");
const BUILDER_ENTRY = path.join(ROOT, "build", "build.js");
/** 客户端入口文件名（无后缀，对应 src/client.ts），与 plugin.json.main 语义一致 */
const CLIENT_ENTRY = "client";
/** 仅客户端版产物根目录（相对项目根），与完整版的 build_dir 相区分 */
const CLIENT_BUILD_DIR = "client";

function fail(message) {
    console.error("[build-plugin] " + message);
    process.exitCode = 1;
}

function main() {
    const clientOnly = process.argv.includes("--client-only");

    if (clientOnly && process.argv.length !== 3) {
        console.warn("[build-plugin] 忽略多余参数，仅识别 --client-only。");
    }

    // 读取并解析 plugin.json；client-only 时临时改写 main 与 build_dir，结束后原样还原
    let raw;
    try {
        raw = fs.readFileSync(PLUGIN_JSON, "utf8");
    } catch (e) {
        return fail("无法读取 " + PLUGIN_JSON + "：" + e.message);
    }
    let conf;
    try {
        conf = JSON.parse(raw);
    } catch (e) {
        return fail("plugin.json 不是合法 JSON：" + e.message);
    }
    const fullBuildDir = (typeof conf.build_dir === "string" && conf.build_dir.length > 0)
        ? conf.build_dir : "dist";
    const dirName = (typeof conf.plugin_dir_name === "string" && conf.plugin_dir_name.length > 0)
        ? conf.plugin_dir_name : conf.name;

    if (clientOnly) {
        conf.main = CLIENT_ENTRY;
        conf.build_dir = CLIENT_BUILD_DIR;
        // plugin_dir_name 保持不变，保证产物文件夹名与完整版一致
        fs.writeFileSync(PLUGIN_JSON, JSON.stringify(conf, null, 4) + "\n");
        console.log("[build-plugin] 构建【仅客户端】版本：入口切至 " + CLIENT_ENTRY +
            "，产物输出到 " + CLIENT_BUILD_DIR + "/<平台>/" + dirName + "。");
    } else {
        console.log("[build-plugin] 构建【完整】版本（等价于直接运行 node build），" +
            "产物输出到 " + fullBuildDir + "/<平台>/" + dirName + "。");
    }

    // Ctrl+C / kill 时先不退出，等子进程结束、finally 还原 plugin.json 后再以约定码退出
    const swallowSignal = () => { /* 交由子进程信号与下方 finally 收尾 */ };
    process.on("SIGINT", swallowSignal);
    process.on("SIGTERM", swallowSignal);

    let exitCode;
    try {
        const result = spawnSync(process.execPath, [BUILDER_ENTRY], {
            cwd: ROOT,
            stdio: "inherit"
        });
        if (result.error) {
            console.error("[build-plugin] 无法启动满月 builder：" + result.error.message);
            exitCode = 1;
        } else if (result.status === null) {
            // 子进程被信号终止（例如用户 Ctrl+C）
            console.error("[build-plugin] 构建被信号中断（" + result.signal + "）。");
            exitCode = 130;
        } else {
            exitCode = result.status;
        }
    } finally {
        // 无论成败都还原 plugin.json（仅 client-only 改写过）
        if (clientOnly) {
            fs.writeFileSync(PLUGIN_JSON, raw);
            console.log("[build-plugin] 已还原 plugin.json。");
        }
    }

    if (exitCode === 0) {
        const mode = clientOnly ? "仅客户端" : "完整";
        const outRoot = clientOnly ? CLIENT_BUILD_DIR : fullBuildDir;
        console.log("[build-plugin] " + mode + "构建完成，产物位于 " + outRoot + "/<平台>/ 下。");
    } else {
        console.error("[build-plugin] 构建失败，退出码 " + exitCode + "。");
    }
    process.exitCode = exitCode;
}

main();
