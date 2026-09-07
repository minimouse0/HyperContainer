import { HTTPContentType, HTTPRequest, Logger } from "../lib/index.js";
import { INFO } from "../lib/plugin_info.js";
import {conf} from "./server/conf.js"
import {db} from "./server/db.js"
import { stopCentralServer } from "./server/central.js";
import { stopEmbeddedClient } from "./client/messenger.js";
// side-effect import：注册 Init/Disable 生命周期（events）
import "./server/events.js";
// full build 命令聚合：以 [客户端, 服务端] 顺序注册 hypercontainer（构造即注册，仅此一次）
import { registerFullBuildCommands } from "./command/setup.js";

registerFullBuildCommands();





export async function stopPlugin(){
    //并行关闭加快速度防止性能浪费
    await Promise.all([
        //关闭tcp服务器
        stopCentralServer(),
        //关闭内嵌客户端使者（释放连接与定时器）
        stopEmbeddedClient(),
        async ()=>{
            //关闭数据库
            db.close()
        }
    ])
}

export async function restartPlugin(){
    Logger.info("正在重启插件")
    await stopPlugin()
    //执行重载自己的命令
    //这里使用了DLSAPI来重载自己
    const DLSAPI=conf.get("DLSAPI")
    if(DLSAPI.address==""||DLSAPI.token==""){
        Logger.error("DLSAPI配置未完成！地址和token至少有一项目前为空。要用此命令重启插件，需要用DLS启动服务器。")
        Logger.fatal("但插件已关闭，请立即手动重启插件。")
        return;
    }
    Logger.info("已发送重启消息并关闭插件，请留意服务器后台日志。")
    Logger.warn("todo：根据所处服务端自行调整重载命令");
    try {
        // 1. 组装并发送请求
        const postData = JSON.stringify({
            token: DLSAPI.token,
            cmd: ["cmd ll reload "+INFO.name]
        });

        // 拼接完整的 URL（假设 DLSAPI.host 包含协议和主机名，例如 http://127.0.0.1）
        const fullUrl = `${DLSAPI.host}:${DLSAPI.port}/execute`;
        
        // 使用方法二发送请求，并等待响应
        const res = await HTTPRequest.sendSimplePOST(
            fullUrl, 
            HTTPContentType.JSON, // 假设你的枚举里有 JSON 类型，若没有可传 'application/json'
            postData
        );

        // 2获取完整的返回数据
        const data=await res.getBody()

        // 3. 处理响应数据（原 onSuccess 逻辑）
        const parsedData = JSON.parse(data);
        if (parsedData.msg === "提交命令成功!") {
            return; // 成功则直接返回
        }
        Logger.error("插件重启失败了，DLS未能执行重启命令");
        Logger.fatal("但插件已关闭，请立即手动重启插件。");
        Logger.info("DLS的信息为：\n" + data);

    } catch (error) {
        // 4. 捕获异常（原 onError 逻辑）
        Logger.fatal("重载请求发送失败，原因：" + error);
        Logger.fatal("但插件已关闭，请立即手动重启插件。");
    }
}

