import { Player, SQLDataType, SQLDataTypeEnum, SQLite3 } from "../../lib/index.js";
import {data_path} from "../../lib/plugin_info.js"

export const db=new SQLite3(data_path+"/client.db")

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