import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {decodePsd} from './psd-preview.mjs';
export function formatKind(ext){ext=String(ext).toLowerCase();return ['jpg','jpeg','png','gif','webp','avif','svg','bmp'].includes(ext)?'image':['tif','tiff','psd'].includes(ext)?'raster':['mp4','webm','ogv','mov'].includes(ext)?'video':['mp3','wav','ogg','oga','m4a','aac','flac','opus'].includes(ext)?'audio':ext==='pdf'?'pdf':['ttf','otf','woff','woff2'].includes(ext)?'font':'file';}
export const mediaMime={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',bmp:'image/bmp',mp4:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',opus:'audio/ogg',pdf:'application/pdf',ttf:'font/ttf',otf:'font/otf',woff:'font/woff',woff2:'font/woff2'};
export function byteRange(header,size){
 if(!header)return null;const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!size||!m[1]&&!m[2])return false;
 let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2])),end=m[1]?(m[2]?Number(m[2]):size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return false;return {start,end:Math.min(end,size-1)};
}
const pending=new Map();
export async function rasterPreview(catalog,row,{thumbnail=false}={}){
 if(JSON.parse(row.metadata).ext.toLowerCase()==='psd'){
  const key=catalog.root+':'+row.hash+':psd:'+thumbnail;if(pending.has(key))return pending.get(key);
  const operation=(async()=>{const dir=path.join(catalog.supportRoot||catalog.root,'previews'),target=path.join(dir,row.hash+'.psd-v1'+(thumbnail?'.thumb':'')+'.png');if(fs.existsSync(target))return target;fs.mkdirSync(dir,{recursive:true});const bytes=thumbnail?await sharp(await rasterPreview(catalog,row)).resize(480,480,{fit:'inside',withoutEnlargement:true}).png().toBuffer():await decodePsd(catalog.path(row.file),{expectedHash:row.hash});if(catalog.row(row.id)?.hash!==row.hash||!fs.existsSync(catalog.path(row.file)))throw Object.assign(Error('素材已被删除或修改'),{status:404});fs.writeFileSync(target+'.tmp',bytes);fs.renameSync(target+'.tmp',target);return target;})().finally(()=>pending.delete(key));pending.set(key,operation);return operation;
 }
 const key=catalog.root+':'+row.hash;if(pending.has(key))return pending.get(key);
 const operation=(async()=>{const dir=path.join(catalog.supportRoot||catalog.root,'previews'),target=path.join(dir,row.hash+'.png');if(fs.existsSync(target))return target;fs.mkdirSync(dir,{recursive:true});const bytes=await sharp(catalog.path(row.file),{limitInputPixels:40000000,pages:1}).timeout({seconds:15}).resize(2400,2400,{fit:'inside',withoutEnlargement:true}).png().toBuffer();fs.writeFileSync(target+'.tmp',bytes);fs.renameSync(target+'.tmp',target);return target;})().finally(()=>pending.delete(key));pending.set(key,operation);return operation;
}
