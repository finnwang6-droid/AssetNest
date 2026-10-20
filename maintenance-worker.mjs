import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {durableWrite} from './storage.mjs';
import {libraryFiles} from './local-layout.mjs';
import {rebuildCatalog} from './rebuild.mjs';
const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));let db,lastSent=0;
const cancelled=()=>{if(fs.existsSync(spec.cancelFile))throw Object.assign(Error('任务已取消'),{cancelled:true});};
function progress(phase,completed=0,total=0,bytes=0,totalBytes=0,force=false){cancelled();if(force||Date.now()-lastSent>100){lastSent=Date.now();process.send?.({type:'progress',phase,completed,total,bytes,totalBytes});}}
function regular(file){const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile())throw Error('任务不接受链接或特殊文件：'+file);return s;}
function contained(root,relative){const file=path.resolve(root,relative);if(!file.startsWith(path.resolve(root)+path.sep))throw Error('文件路径越界');return file;}
function hash(file){regular(file);const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))){cancelled();h.update(buffer.subarray(0,n));}return h.digest('hex');}finally{fs.closeSync(fd);}}
function enumerate(root,prefix=''){if(fs.lstatSync(root).isSymbolicLink())throw Error('目录不能为链接');const result=[];for(const entry of fs.readdirSync(root,{withFileTypes:true})){cancelled();const file=path.join(root,entry.name),name=prefix+entry.name;if(entry.isSymbolicLink())throw Error('目录中包含链接：'+name);if(entry.isDirectory())result.push(...enumerate(file,name+'/'));else {const stat=regular(file);result.push({relative:name,file,bytes:stat.size,modified:stat.mtimeMs});}}return result;}
function integrity(){
 const issues=[];let issueCount=0;const issue=v=>{issueCount++;if(issues.length<1000)issues.push(v);};
 progress('检查数据库',0,0,0,0,true);for(const row of db.prepare('PRAGMA integrity_check').all())if(Object.values(row)[0]!=='ok')issue({kind:'sqlite',detail:Object.values(row)[0]});
 const count=db.prepare('SELECT count(*) AS n FROM items').get().n,images=path.join(spec.source,'images');if(fs.lstatSync(images).isSymbolicLink())throw Error('素材目录不能为链接');let done=0;
 const findSource=db.prepare('SELECT * FROM item_sources WHERE id=?');
 for(const row of db.prepare('SELECT * FROM items').iterate()){
  cancelled();const file=contained(images,row.file);for(const relative of [row.file,row.thumb].filter(Boolean))if(!fs.existsSync(contained(images,relative)))issue({id:row.id,kind:'missing-file',file:relative});
  if(fs.existsSync(file)&&hash(file)!==row.hash)issue({id:row.id,kind:'content-hash-mismatch'});
  try{const actual=JSON.parse(fs.readFileSync(contained(images,row.id+'.info/metadata.json'),'utf8').replace(/^\uFEFF/,'')),source=findSource.get(row.id);if(JSON.stringify(actual)!==JSON.stringify(JSON.parse(source?.file_metadata??row.metadata)))issue({id:row.id,kind:'metadata-mismatch'});}catch(e){issue({id:row.id,kind:'metadata-unreadable',detail:e.message});}
  progress('核对原图与元数据',++done,count);
 }
 for(const entry of fs.readdirSync(images))if(entry.endsWith('.info')&&!db.prepare('SELECT id FROM items WHERE id=?').get(entry.slice(0,-5)))issue({kind:'unindexed-directory',directory:entry});
 const folders=db.prepare('SELECT f.id,i.parent_id FROM folders f LEFT JOIN folder_index i ON i.id=f.id').all(),ids=new Set(folders.map(f=>f.id)),map=new Map(folders.map(f=>[f.id,f]));
 for(const row of db.prepare('SELECT id,metadata FROM items').iterate())for(const id of JSON.parse(row.metadata).folders||[])if(!ids.has(id))issue({id:row.id,kind:'missing-folder-reference',folderId:id});
 for(const f of folders){if(f.parent_id&&!ids.has(f.parent_id))issue({id:f.id,kind:'missing-parent-folder'});let current=f;const seen=new Set();while(current){if(seen.has(current.id)){issue({id:f.id,kind:'folder-cycle'});break;}seen.add(current.id);current=map.get(current.parent_id);}}
 progress('检查完成',count,count,0,0,true);return {healthy:!issueCount,items:count,issueCount,issues,truncated:issueCount>issues.length};
}
function backup(){
 const report=integrity();if(!report.healthy)throw Error('完整性检查发现 '+report.issueCount+' 个问题，未创建备份');
 const sourceFiles=enumerate(path.join(spec.source,'images')).map(e=>({...e,relative:'images/'+e.relative}));for(const name of libraryFiles)if(fs.existsSync(path.join(spec.source,name)))sourceFiles.push({file:path.join(spec.source,name),relative:name,bytes:regular(path.join(spec.source,name)).size,modified:regular(path.join(spec.source,name)).mtimeMs});
 let size=sourceFiles.reduce((n,e)=>n+e.bytes,0)+Number(db.prepare('PRAGMA page_count').get().page_count)*Number(db.prepare('PRAGMA page_size').get().page_size),disk=fs.statfsSync(path.dirname(spec.stage));if(Number(disk.bavail)*Number(disk.bsize)<size*1.15+16*1024**2)throw Error('备份目标磁盘空间不足');
 fs.mkdirSync(spec.stage);durableWrite(path.join(spec.stage,'.assetnest-job-owner'),spec.id);
 progress('复制数据库快照',0,sourceFiles.length+1,0,size,true);db.prepare('VACUUM INTO ?').run(path.join(spec.stage,'catalog.sqlite'));let copied=fs.statSync(path.join(spec.stage,'catalog.sqlite')).size,done=1;size=sourceFiles.reduce((n,e)=>n+e.bytes,0)+copied;
 for(const entry of sourceFiles){cancelled();const target=contained(spec.stage,entry.relative);fs.mkdirSync(path.dirname(target),{recursive:true});const input=fs.openSync(entry.file,'r'),output=fs.openSync(target,'wx'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(input,buffer,0,buffer.length,null))){cancelled();let offset=0;while(offset<n)offset+=fs.writeSync(output,buffer,offset,n-offset);copied+=n;progress('复制素材文件',done,sourceFiles.length+1,copied,size);}fs.fsyncSync(output);}finally{fs.closeSync(input);fs.closeSync(output);}progress('复制素材文件',++done,sourceFiles.length+1,copied,size);}
 const checksums={},files=enumerate(spec.stage).filter(e=>e.relative!=='.assetnest-job-owner');done=0;for(const entry of files){checksums[entry.relative]=hash(entry.file);progress('校验备份文件',++done,files.length,copied,size);}
 const snapshot=new DatabaseSync(path.join(spec.stage,'catalog.sqlite'),{readOnly:true});try{for(const row of snapshot.prepare('SELECT id,file,thumb,hash,metadata FROM items').iterate()){cancelled();if(checksums['images/'+row.file]!==row.hash)throw Error('备份原图校验失败：'+row.id);if(row.thumb&&!checksums['images/'+row.thumb])throw Error('备份缩略图缺失：'+row.id);const raw=snapshot.prepare('SELECT file_metadata FROM item_sources WHERE id=?').get(row.id)?.file_metadata??row.metadata;if(JSON.stringify(JSON.parse(raw))!==JSON.stringify(JSON.parse(fs.readFileSync(contained(spec.stage,'images/'+row.id+'.info/metadata.json'),'utf8').replace(/^\uFEFF/,''))))throw Error('备份元数据校验失败：'+row.id);}if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('备份数据库校验失败');}finally{snapshot.close();}
 for(const entry of sourceFiles){cancelled();const current=regular(entry.file);if(current.size!==entry.bytes||current.mtimeMs!==entry.modified)throw Error('原素材库文件在备份过程中发生变化：'+entry.relative);}
 const manifest={version:1,createdAt:Date.now(),items:report.items,checksums};durableWrite(path.join(spec.stage,'backup.json'),JSON.stringify(manifest));progress('备份校验完成',files.length,files.length,copied,copied,true);return {items:report.items,fileCount:files.length,bytes:copied,verified:true};
}
try{
 let result;if(spec.type==='rebuild'){
  fs.mkdirSync(spec.stage);durableWrite(path.join(spec.stage,'.assetnest-job-owner'),spec.id);
  result=rebuildCatalog(spec.source,spec.stage,{sourceLocked:true,sourceDatabase:spec.dbFile,ownedToken:spec.id,checkCancelled:cancelled,onProgress:(completed,total,phase)=>progress(phase||'重建索引',completed,total)});
 }else{db=new DatabaseSync(spec.dbFile,{readOnly:true});result=spec.type==='backup'?backup():integrity();}
 cancelled();process.send?.({type:'result',result},()=>process.disconnect?.());
}catch(e){process.send?.({type:'error',error:e.message,cancelled:!!e.cancelled},()=>process.disconnect?.());process.exitCode=1;}finally{db?.close();}
