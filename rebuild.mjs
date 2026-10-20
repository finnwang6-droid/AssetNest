import {filePayload,payloadHash} from './file-payload.mjs';
import {libraryFiles} from './local-layout.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Catalog,acquireWriter,validId,digest,fail} from './storage.mjs';

export function rebuildCatalog(source,target,{sourceLocked=false,sourceDatabase=null,ownedToken=null,checkCancelled=()=>{},onProgress=()=>{}}={}){
 const from=path.resolve(source),to=path.resolve(target);
 if(to===from||to.startsWith(from+path.sep)||from.startsWith(to+path.sep))throw fail('重建必须使用独立的新目录');
 if(fs.existsSync(to)&&fs.readdirSync(to).some(n=>!(ownedToken&&n==='.assetnest-job-owner'&&fs.readFileSync(path.join(to,n),'utf8')===ownedToken)))throw fail('重建目标必须为空，不覆盖现有库');
 const guard=sourceLocked?{release(){}}:acquireWriter(from);let database,catalog,staged=0;
 try{
  const report={kind:'rebuild',createdAt:Date.now(),source:from,target:to,items:0,warnings:[]},indexed=new Map(),sources=new Map(),folders=[],packs=[],smartFolders=[];
  try{
   database=new DatabaseSync(sourceDatabase||path.join(from,'catalog.sqlite'),{readOnly:true});
   for(const row of database.prepare('SELECT * FROM items').all())indexed.set(row.id,row);
   if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_folders'").get())smartFolders.push(...database.prepare('SELECT * FROM smart_folders').all());
   let parentIndex=new Map();try{parentIndex=new Map(database.prepare('SELECT * FROM folder_index').all().map(f=>[f.id,f.parent_id]));}catch{}
   for(const row of database.prepare('SELECT * FROM folders').all()){const raw=JSON.parse(row.metadata),parentId=parentIndex.has(row.id)?parentIndex.get(row.id):raw.parentId??null;if(!parentIndex.has(row.id))delete raw.parentId;folders.push({id:row.id,raw,parentId});}
   try{for(const s of database.prepare('SELECT * FROM item_sources').all())sources.set(s.id,s);for(const p of database.prepare('SELECT * FROM packs').all())packs.push({id:p.id,envelope:JSON.parse(p.envelope)});}catch{}
  }catch{report.warnings.push('原索引无法完整读取，遗失的素材包根字段无法保证恢复；文件夹优先从库根记录恢复，缺失时使用占位记录');}finally{database?.close();}
  if(!folders.length){try{const root=JSON.parse(fs.readFileSync(path.join(from,'metadata.json'),'utf8').replace(/^\uFEFF/,''));const visit=(raw,parentId=null)=>{if(!validId(raw.id))throw fail('原文件夹 ID 无效');folders.push({id:raw.id,raw,parentId});for(const child of raw.children||[])visit(child,raw.id);};for(const raw of root.folders||[])visit(raw);}catch(e){report.warnings.push('原文件夹根记录未能读取：'+e.message);}}
  const items=[],total=fs.readdirSync(path.join(from,'images')).length;onProgress(0,total,'扫描素材目录');
  for(const entry of fs.readdirSync(path.join(from,'images'),{withFileTypes:true})){
   if(entry.isSymbolicLink()||!entry.isDirectory()||!entry.name.endsWith('.info')||!validId(entry.name.slice(0,-5)))throw fail('发现无法识别的素材目录，停止重建：'+entry.name);
   checkCancelled();const id=entry.name.slice(0,-5),dir=path.join(from,'images',entry.name);let disk;try{disk=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8').replace(/^\uFEFF/,''));}catch{throw fail('元数据缺失或损坏，不能静默跳过：'+id);}
   if(disk.id!==id||typeof disk.name!=='string'||typeof disk.ext!=='string'||!/^[a-z0-9]{1,12}$/i.test(disk.ext))throw fail('素材记录无法识别：'+id);
   const names=fs.readdirSync(dir);if(names.some(n=>fs.lstatSync(path.join(dir,n)).isSymbolicLink()||!fs.lstatSync(path.join(dir,n)).isFile()))throw fail('素材包含链接或子目录，需人工检查：'+id);
   const old=indexed.get(id),s=sources.get(id),raw=old?JSON.parse(old.metadata):disk;
   const candidates=[old?.file?path.basename(old.file):null,'original.'+disk.ext.toLowerCase(),disk.name+'.'+disk.ext].filter(n=>n&&path.basename(n)===n&&names.includes(n));
   const original=[...new Set(candidates)][0];if(!original)throw fail('无法唯一定位原文件：'+id);
   const thumb=[old?.thumb?path.basename(old.thumb):null,'thumbnail.png',disk.name+'_thumbnail.png'].find(n=>n&&path.basename(n)===n&&names.includes(n));
   const files=Object.fromEntries(names.filter(n=>n!=='metadata.json').map(n=>[n,filePayload(path.join(dir,n))]));
   items.push({row:{id,metadata:JSON.stringify(raw),file:id+'.info/'+original,thumb:thumb?id+'.info/'+thumb:null,hash:payloadHash(files[original])},source:{file_metadata:s?s.file_metadata:JSON.stringify(disk),pack_id:s?.pack_id&&packs.some(p=>p.id===s.pack_id)?s.pack_id:null},files});onProgress(items.length,total,'核对素材与索引');
   for(const folderId of raw.folders||[])if(!folders.some(f=>f.id===folderId)){if(!validId(folderId))throw fail('文件夹引用无效：'+id);folders.push({id:folderId,parentId:null,raw:{id:folderId,name:'恢复的文件夹 '+folderId,children:[]}});report.warnings.push('文件夹 '+folderId+' 的名称/层级丢失，使用明确标注的恢复占位记录');}
  }
  for(const id of indexed.keys())if(!items.some(i=>i.row.id===id))throw fail('原索引有记录但对应素材目录缺失：'+id);
  report.items=items.length;catalog=new Catalog(to,{fault:phase=>{checkCancelled();if(phase==='after-stage-item')onProgress(++staged,items.length,'写入新的素材库');}});for(const name of libraryFiles)if(fs.existsSync(path.join(from,name)))fs.copyFileSync(path.join(from,name),path.join(to,name));catalog.commit({items,folders,packs});for(const s of smartFolders)catalog.db.prepare('INSERT INTO smart_folders VALUES(?,?,?)').run(s.id,s.name,s.conditions);checkCancelled();onProgress(0,items.length,'校验重建结果');const integrity=catalog.integrity();checkCancelled();onProgress(items.length,items.length,'重建完成');if(!integrity.healthy)throw fail('重建后检查未通过：'+JSON.stringify(integrity.issues));return {...report,healthy:true};
 }finally{catalog?.close();guard.release();}
}
