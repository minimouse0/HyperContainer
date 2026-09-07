/**
 * 完整版主入口：启用中心服务端。
 * nodejs 平台 = 独立中心服；llse 平台 = 群组内某台服务器承载中心服（自连客户端逻辑在后续阶段接入）。
 * Phase 1 只拉起 TCP 监听，配置暂用默认值（可被 HC_PORT 等环境变量覆盖，Phase 2 移到配置文件）。
 */

import { stopPlugin } from "../index.js";
import { DisableEvent, InitEvent, Logger, Player, PlayerJoinEvent } from "../../lib/index.js";
import { PLATFORM } from "../../lib/plugin_info.js";
import { CentralServerHandle, startCentralServer } from "./central.js";
import { centralServerConfig, ensureEmbeddedIdentity, initConf } from "./conf.js";
import { db, ensurePlayerContainer } from "./db.js";
import { startEmbeddedClient } from "../client/messenger.js";




export let pluginLaunched=false;
/**
 * 监听插件自身初始化完成事件
 * @param listener 函数可以为异步，如果函数返回了promise，那么init完成时，后续事件会等待函数resolve而不会并行
 */
export async function listenInit(listener:()=>any){
    if(pluginLaunched){
        //如果插件初始化过了，那么直接执行，不加入队列
        await listener()
    }else{
        //加入队列，等待初始化
        internalInitEvents.push(listener)
    }
}

export const internalInitEvents:(()=>any)[]=[]

InitEvent.on(() => {
    (async () => {
        
        //初始化所有流程，传进promise.all的数组是所有要被触发的async初始化函数
        //初始化事件中可能包含异步函数，所以这里被包装成了异步
        await Promise.all([initConf()]).then(async value=>{
            //初始化流程结束后，设置初始化状态为true
            pluginLaunched=true;
            //然后触发所有积压的初始化事件
            while(internalInitEvents.length>0){
                //第一位是最早进入的，以先进先出原则执行
                await internalInitEvents[0]()
                internalInitEvents.shift()
            }
        })
        try {
            // llse full build：先确保本服身份（token uuid + servers.local），再启动中心服
            if ((PLATFORM as string) === "llse") await ensureEmbeddedIdentity()
            await startCentralServer(centralServerConfig());
            Logger.info("HyperContainer 中心服启动完成。");
            // llse：内嵌客户端使者经 localhost 自连中心服（nodejs 平台跳过）
            await startEmbeddedClient();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            Logger.error("HyperContainer 中心服启动失败：" + message);
        }
    })();
    return true;
});

DisableEvent.on(() => {
    stopPlugin()
    return true;
});

PlayerJoinEvent.on((e:PlayerJoinEvent)=>{
    playerJoinEventHandler(e.player)
})

//既然已经分离出来，那么这个函数可以被随意移动到其他代码文件，也可以随意进行重构与拆解，毕竟已经与PlayerJoinEvent.on的调用解耦
export function playerJoinEventHandler(player:Player){listenInit(async ()=>{
    try {
        //先开始写入玩家个人信息
        db.setRowFromPrimaryKey("player_info",player.uuid,{
            columnName:"xuid",
            value:player.xuid
        },{
            columnName:"name",
            value:player.name
        })
        // M3：首次进服（或容器曾被删除后再次进服）自动确保该玩家拥有唯一容器（幂等）
        const container=ensurePlayerContainer(player.uuid)
        Logger.info("玩家进服处理完成：uuid="+player.uuid+" 容器="+container.id)
    } catch (e) {
        const message=e instanceof Error?e.message:String(e)
        Logger.error("处理玩家进服事件出错（uuid="+player.uuid+"）："+message)
    }
})}
