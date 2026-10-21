import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {filePayload,payloadHash} from './file-payload.mjs';
const fail=message=>Object.assign(Error(message),{status:400});
const inputs=new Set(['jpg','jpeg','png','webp','avif','tif','tiff','gif']);
export function fileExportOptions(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail('导出选项无效');
 const options={mode:value.mode??'original',format:value.format??'png',quality:Number(value.quality??90),maxEdge:Number(value.maxEdge??0),background:value.background??'#ffffff'};
 if(!['original','convert'].includes(options.mode)||!['jpg','png','webp'].includes(options.format))throw fail('导出格式无效');
 if(!Number.isInteger(options.quality)||options.quality<1||options.quality>100)throw fail('图片质量需要为 1～100');
 if(!Number.isInteger(options.maxEdge)||options.maxEdge<0||options.maxEdge>10000)throw fail('最长边需要为 0～10000 像素');
 if(typeof options.background!=='string'||!/^#[0-9a-f]{6}$/i.test(options.background))throw fail('背景色需要为 #RRGGBB');
 return options;
}
export function exportFilename(name,ext,used=new Set()){
 let stem=String(name||'未命名').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().replace(/[. ]+$/,'');
 if(stem.toLowerCase().endsWith('.'+ext.toLowerCase()))stem=stem.slice(0,-ext.length-1);
 if(!stem)stem='未命名';if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem))stem='_'+stem;
 stem=[...stem].slice(0,100).join('');while(Buffer.byteLength(stem)>180)stem=[...stem].slice(0,-1).join('');
 let nameOut=stem+'.'+ext,n=1;while(used.has(nameOut.toLocaleLowerCase('en-US')))nameOut=stem+' ('+(++n)+').'+ext;used.add(nameOut.toLocaleLowerCase('en-US'));return nameOut;
}
export function planFileExport(catalog,ids,settings={}){
 const options=fileExportOptions(settings);
 if(!Array.isArray(ids)||!ids.length||ids.length>500||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id)))throw fail('请选择 1～500 个不同素材');
 const used=new Set(),items=ids.map((id,index)=>{
  const row=catalog.row(id);if(!row)throw fail('第 '+(index+1)+' 项素材不存在');const m=JSON.parse(row.metadata),ext=String(m.ext||'').toLowerCase();
  if(!/^[a-z0-9]{1,12}$/.test(ext))throw fail('素材扩展名无效：'+m.name);
  if(options.mode==='convert'&&!inputs.has(ext))throw fail('暂不支持转换此格式：'+m.name+'（'+ext+'），请选择导出原件');
  const file=catalog.path(row.file);if(!fs.existsSync(file)||!fs.lstatSync(file).isFile())throw fail('原文件缺失或不是普通文件：'+m.name);
  for(let parent=path.dirname(file);parent!==path.resolve(catalog.images);parent=path.dirname(parent))if(fs.lstatSync(parent).isSymbolicLink())throw fail('原文件目录不能经过链接：'+m.name);
  const data=filePayload(file);if(options.mode==='convert'&&data.length>100*1024**2)throw fail('图片超过转换上限 100MB：'+m.name);
  return {id,row,name:m.name,ext,output:exportFilename(m.name,options.mode==='convert'?options.format:ext,used),data};
 });return {options,items,totalBytes:items.reduce((n,i)=>n+i.data.length,0)};
}
export async function convertFileExport(catalog,item,options,{directory,index,signal}){
 signal.throwIfAborted();catalog.assertSpace(item.data.length+50*1024**2);
 const source=path.join(directory,'source-'+index),output=path.join(directory,'image-'+index+'.'+options.format);
 try{
  await fs.promises.copyFile(item.data.path,source);signal.throwIfAborted();
  if(payloadHash(filePayload(source))!==item.row.hash)throw fail('原文件内容与索引不一致：'+item.name);
  const image=sharp(source,{limitInputPixels:40000000,failOn:'error'}).timeout({seconds:15}),meta=await image.metadata();
  if(!['jpeg','png','webp','heif','tiff','gif'].includes(meta.format))throw fail('文件内容不是支持的静态图片：'+item.name);
  if((meta.pages||1)>1)throw fail('多帧或多页图片不做静态转换，请导出原件：'+item.name);
  let pipeline=image.rotate().toColourspace('srgb');if(options.maxEdge)pipeline=pipeline.resize(options.maxEdge,options.maxEdge,{fit:'inside',withoutEnlargement:true});
  if(options.format==='jpg')pipeline=pipeline.flatten({background:options.background}).jpeg({quality:options.quality});else if(options.format==='webp')pipeline=pipeline.webp({quality:options.quality});else pipeline=pipeline.png();
  const info=await pipeline.toFile(output);signal.throwIfAborted();if(info.size>50*1024**2)throw fail('转换结果超过 50MB：'+item.name);
  const data=filePayload(output);return {name:item.output,data,hash:payloadHash(data),result:{name:item.output,width:info.width,height:info.height,size:info.size}};
 }finally{if(fs.existsSync(source))fs.unlinkSync(source);}
}
