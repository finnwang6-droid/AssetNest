import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {filePayload,payloadHash} from './file-payload.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const pdfThumbnailLimit=32*1024**2;
export function cachedPdfThumbnail(previews,row){const file=path.join(previews.cache.directory,row.hash+'.pdf-v1.thumb.png');previews.cache.check();if(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()){previews.cache.register(file);previews.cache.touch(file);return file;}return null;}
export async function storePdfThumbnail(catalog,previews,id,hash,bytes){
 const check=()=>{if(!previews.alive())throw fail('素材库已关闭',409);const row=catalog.row(id);if(!row||row.hash!==hash||JSON.parse(row.metadata).ext.toLowerCase()!=='pdf')throw fail('PDF 素材已变化或不存在',409);const file=catalog.path(row.file);if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>pdfThumbnailLimit)throw fail('PDF 原件缺失或超过 32 MB 封面生成上限');return row;};
 let row=check();if(previews.paused)throw fail('后台预览已暂停，请在任务与维护中继续生成',409);
 if(bytes.length>2*1024**2||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw fail('PDF 缩略图必须为 2 MB 以内的 PNG');
 const image=sharp(bytes,{limitInputPixels:1024**2}),info=await image.metadata();if(!info.width||!info.height||info.width>1024||info.height>1024)throw fail('PDF 缩略图尺寸超过上限');const normalized=await image.png().toBuffer();row=check();if(payloadHash(filePayload(catalog.path(row.file)))!==hash)throw fail('PDF 原件哈希校验失败，未保存预览');
 previews.cache.check();fs.mkdirSync(previews.cache.directory,{recursive:true});const target=path.join(previews.cache.directory,hash+'.pdf-v1.thumb.png'),tmp=target+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,normalized,{flag:'wx'});fs.renameSync(tmp,target);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}previews.cache.register(target);previews.cache.enforce();return {saved:true,id,hash};
}
