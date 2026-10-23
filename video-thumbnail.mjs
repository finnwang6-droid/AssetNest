import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import sharp from 'sharp';
import {filePayload,payloadHash} from './file-payload.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const videoExtensions=['mp4','webm','ogv','mov'];
export function cachedVideoThumbnail(previews,row){const file=path.join(previews.cache.directory,row.hash+'.video-v1.thumb.png');previews.cache.check();if(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()){previews.cache.register(file);previews.cache.touch(file);return file;}return null;}
export async function storeVideoThumbnail(catalog,previews,id,hash,bytes,info){
 const check=()=>{if(!previews.alive())throw fail('素材库已关闭',409);const row=catalog.row(id);if(!row||row.hash!==hash||!videoExtensions.includes(JSON.parse(row.metadata).ext.toLowerCase()))throw fail('视频已变化或不存在',409);const file=catalog.path(row.file);if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>256*1024**2)throw fail('视频原件缺失或超过 256 MB 封面生成上限');return row;};
 let row=check();if(previews.paused)throw fail('后台预览已暂停',409);
 if(!info||![info.width,info.height,info.duration].every(Number.isFinite)||!Number.isInteger(info.width)||!Number.isInteger(info.height)||info.width<1||info.height<1||info.width>100000||info.height>100000||info.duration<0||info.duration>604800)throw fail('视频尺寸或时长无效');
 if(bytes.length>2*1024**2||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw fail('视频封面需要为 2 MB 以内的 PNG');
 const image=sharp(bytes,{limitInputPixels:1024**2}),size=await image.metadata();if(!size.width||!size.height||size.width>1024||size.height>1024)throw fail('视频封面尺寸超过上限');const normalized=await image.png().toBuffer();row=check();if(previews.paused)throw fail('后台预览已暂停',409);if(payloadHash(filePayload(catalog.path(row.file)))!==hash)throw fail('视频原件哈希校验失败');
 previews.cache.check();fs.mkdirSync(previews.cache.directory,{recursive:true});const target=path.join(previews.cache.directory,hash+'.video-v1.thumb.png'),tmp=target+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,normalized,{flag:'wx'});fs.renameSync(tmp,target);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catalog.db.prepare('INSERT OR REPLACE INTO media_info VALUES(?,?,?,?,?)').run(id,hash,info.width,info.height,info.duration);previews.cache.register(target);previews.cache.enforce();return {saved:true,id,hash,...info};
}
