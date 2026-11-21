import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
const error=(message,status=400)=>Object.assign(Error(message),{status});
const openable=new Set('jpg jpeg png gif webp avif svg bmp tif tiff psd ai pdf eps mp4 webm ogv mov mp3 wav ogg oga m4a aac flac opus ttf otf woff woff2'.split(' '));
function launch(exe,args,options,done){const child=spawn(exe,args,{...options,stdio:'ignore',detached:true});child.once('error',done);child.once('spawn',()=>{child.unref();done(null);});}
export function desktopItemPath(catalog,id){const row=catalog.row(id);if(!row)throw error('素材不存在',404);const file=catalog.path(row.file);if(!fs.existsSync(file))throw error('原文件已丢失，请先检查素材库',404);const real=fs.realpathSync(file),root=fs.realpathSync(catalog.images);if(!real.toLowerCase().startsWith((root+path.sep).toLowerCase())||!fs.statSync(real).isFile())throw error('素材文件路径无效');return {file:real,ext:String(JSON.parse(row.metadata).ext).toLowerCase()};}
export function desktopDragFiles(catalog,ids){if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(id)))throw error('请选择 1 至 500 个素材');return {files:[...new Set(ids)].map((id,index)=>{try{return desktopItemPath(catalog,id).file;}catch(e){let name;try{name=JSON.parse(catalog.row(id)?.metadata||'{}').name;}catch{}const label=typeof name==='string'?`「${name.slice(0,60)}」`:'';throw error(`第 ${index+1} 项${label}：${e.message}`,e.status||400);}})};}
export async function desktopAction(catalog,action,id,{run=launch,platform=process.platform}={}){if(!['reveal','open'].includes(action))throw error('桌面操作不存在',404);if(!['win32','darwin'].includes(platform))throw error('此操作需要桌面客户端');const {file,ext}=desktopItemPath(catalog,id);if(action==='open'&&!openable.has(ext))throw error('该格式请先定位到文件夹，再选择打开方式');const executable=platform==='darwin'?'/usr/bin/open':path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe');await new Promise((resolve,reject)=>run(executable,platform==='darwin'?(action==='reveal'?['-R',file]:[file]):(action==='reveal'?['/select,',file]:[file]),{windowsHide:true},e=>e?reject(error('无法打开文件位置：'+e.message)):resolve()));return {ok:true,action};}

// Only the authenticated local API invokes this; callers cannot choose an executable or command.
export async function showDesktopWindow({root,port,platform=process.platform,run=execFile,send=process.send?.bind(process),connected=process.connected}={}){
 if(platform==='win32'){
  if(!Number.isInteger(port)||port<1024||port>65535)throw error('端口无效');
  await new Promise((resolve,reject)=>run(path.resolve(root,'..','AssetNest.exe'),['/show','/port='+port],{windowsHide:true,timeout:5000},e=>e?reject(error('无法唤起桌面窗口，请启动或更新拾素材 Windows 客户端',409)):resolve()));
 }else{
  if(typeof send!=='function'||!connected)throw error('桌面窗口不可用，请启动桌面客户端',409);
  await new Promise((resolve,reject)=>send({type:'assetnest-show'},e=>e?reject(error('无法唤起桌面窗口',503)):resolve()));
 }
 return {ok:true};
}
