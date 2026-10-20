import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Catalog,acquireWriter,durableWrite,validId,fail,digest} from './storage.mjs';
import {libraryFiles} from './local-layout.mjs';
import {filePayload,payloadHash} from './file-payload.mjs';
import {syncDocument} from './search.mjs';
import {createBackup,verifyBackup} from './backup.mjs';

export function isEagleLibrary(root){return !fs.existsSync(path.join(root,'catalog.sqlite'))&&fs.existsSync(path.join(root,'metadata.json'))&&fs.existsSync(path.join(root,'images'));}
export function eagleRunning(){if(process.platform!=='win32')return false;const result=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32/tasklist.exe'),['/FI','IMAGENAME eq Eagle.exe','/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:5000});if(result.status!==0)throw fail('无法检查 Eagle 的运行状态，请先退出 Eagle 后重试',503);return /"eagle\.exe"/i.test(result.stdout);}
const readJSON=file=>{if(fs.statSync(file).size>32*1024*1024)throw fail('JSON 文件超过 32MB：'+path.basename(file));try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fail('Eagle JSON 损坏或正在写入：'+file);}};
const regular=file=>{if(fs.lstatSync(file).isSymbolicLink())throw fail('Eagle 库不接受目录或文件链接：'+file);};
const hashFile=file=>fs.existsSync(file)?payloadHash(filePayload(file)):null;
function directoryHash(directory){if(!fs.existsSync(directory))return null;regular(directory);const hash=crypto.createHash('sha256');function walk(dir,prefix=''){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);regular(file);const relative=prefix+name;if(fs.statSync(file).isDirectory())walk(file,relative+'/');else hash.update(JSON.stringify([relative,hashFile(file)]));}}walk(directory);return hash.digest('hex');}

export function scanEagle(root){
 regular(root);const images=path.join(root,'images');regular(images);const metadataFile=path.join(root,'metadata.json');regular(metadataFile);const metadata=readJSON(metadataFile);if(!metadata||typeof metadata!=='object'||!Array.isArray(metadata.folders))throw fail('请选择 Eagle .library 根目录（需要 metadata.json 和 images）');
 const folders=[],folderIDs=new Set(),fingerprint=crypto.createHash('sha256'),records=[];
 for(const name of libraryFiles){const file=path.join(root,name);if(fs.existsSync(file)){regular(file);fingerprint.update(JSON.stringify([name,hashFile(file)]));}}
 function visit(folder,parentId=null,depth=0){if(depth>64||!folder||!validId(folder.id)||typeof folder.name!=='string'||folder.children!==undefined&&!Array.isArray(folder.children)||folderIDs.has(folder.id.toLowerCase()))throw fail('Eagle 文件夹记录无效或重复');folderIDs.add(folder.id.toLowerCase());folders.push({id:folder.id,raw:folder,parentId});for(const child of folder.children||[])visit(child,folder.id,depth+1);}
 for(const folder of metadata.folders)visit(folder);
 const seen=new Set();for(const name of fs.readdirSync(images).sort()){
  if(!name.endsWith('.info'))continue;const id=name.slice(0,-5);if(!validId(id)||seen.has(id.toLowerCase()))throw fail('Eagle 素材目录 ID 无效或冲突：'+name);seen.add(id.toLowerCase());const directory=path.join(images,name);regular(directory);const metaFile=path.join(directory,'metadata.json');if(!fs.existsSync(metaFile))throw fail('Eagle 素材缺少 metadata.json：'+name);regular(metaFile);const m=readJSON(metaFile);
  if(m.id!==id||typeof m.name!=='string'||!m.name||/[\\/\x00]/.test(m.name)||typeof m.ext!=='string'||!/^[a-z0-9]{1,12}$/i.test(m.ext)||['tags','folders'].some(k=>m[k]!==undefined&&(!Array.isArray(m[k])||m[k].some(v=>typeof v!=='string'))))throw fail('Eagle 素材记录格式无效：'+id);
  if((m.folders||[]).some(id=>!folders.some(f=>f.id===id)))throw fail('Eagle 素材引用不存在的文件夹：'+id);
  const files=fs.readdirSync(directory).sort();for(const file of files){const absolute=path.join(directory,file);regular(absolute);if(!fs.statSync(absolute).isFile())throw fail('暂不支持带嵌套附属目录的 Eagle 素材：'+id);const stat=fs.statSync(absolute,{bigint:true});fingerprint.update(JSON.stringify([name+'/'+file,stat.size.toString(),stat.mtimeNs.toString(),stat.ctimeNs.toString(),file==='metadata.json'?hashFile(absolute):null]));}
  let original=files.find(n=>n.toLowerCase()===(m.name+'.'+m.ext).toLowerCase());if(!original){const candidates=files.filter(n=>n!=='metadata.json'&&!/_thumbnail\./i.test(n)&&path.extname(n).toLowerCase()==='.'+m.ext.toLowerCase());if(candidates.length!==1)throw fail('无法唯一定位 Eagle 原文件：'+id);original=candidates[0];}
  const thumb=files.find(n=>n.toLowerCase()===(m.name+'_thumbnail.png').toLowerCase())||files.find(n=>/_thumbnail\.(png|webp|jpg)$/i.test(n))||null;
  const raw=fs.readFileSync(metaFile,'utf8').replace(/^\uFEFF/,'');records.push({id,metadata:raw,file:name+'/'+original,thumb:thumb?name+'/'+thumb:null});
 }
 return {fingerprint:fingerprint.digest('hex'),folders,records};
}
function transactionGuard(catalog,phase,manifest,tx){
 if(phase==='stage')return {version:1,items:manifest.operations.map(op=>({id:op.id,old:directoryHash(path.join(catalog.images,op.id+'.info')),next:directoryHash(path.join(tx,'staged',op.id+'.info'))})),roots:manifest.rootOperations.map(op=>({name:op.name,old:hashFile(path.join(catalog.root,op.name)),next:null}))};
 return {...manifest.externalGuard,roots:manifest.externalGuard.roots.map(op=>({...op,next:hashFile(path.join(tx,'root-staged',op.name))}))};
}
function recoverCheck(isBusy,catalog,manifest,tx,committed){
 if(committed)return;if(isBusy())throw fail('Eagle 正在运行，请退出后再恢复未完成写入',409);const guard=manifest.externalGuard;
 if(guard?.version!==1||!Array.isArray(guard.items)||!Array.isArray(guard.roots)||guard.items.length!==manifest.operations.length||guard.roots.length!==manifest.rootOperations.length)throw fail('Eagle 写入恢复日志缺少校验记录，请保留日志并检查');
 for(const op of guard.items){if(!validId(op.id)||!manifest.operations.some(v=>v.id===op.id))throw fail('恢复素材 ID 无效');for(const [dir,allowed]of [[path.join(catalog.images,op.id+'.info'),[op.old,op.next]],[path.join(tx,'backup',op.id+'.info'),[op.old]],[path.join(tx,'staged',op.id+'.info'),[op.next]]])if(fs.existsSync(dir)&&!allowed.includes(directoryHash(dir)))throw fail('Eagle 原库在中断后发生外部修改，已停止自动恢复：'+op.id);}
 for(const op of guard.roots){if(!libraryFiles.includes(op.name))throw fail('恢复根文件无效');for(const [file,allowed]of [[path.join(catalog.root,op.name),[op.old,op.next]],[path.join(tx,'root-backup',op.name),[op.old]],[path.join(tx,'root-staged',op.name),[op.next]]])if(fs.existsSync(file)&&!allowed.includes(hashFile(file)))throw fail('Eagle 根文件在中断后发生修改，已停止自动恢复：'+op.name);}
}
export function openEagleLibrary(root,supportRoot,{isBusy=eagleRunning,fault}={}){
 const transactions=path.join(root,'.assetnest-transactions');if(fs.existsSync(transactions)){regular(transactions);if(fs.readdirSync(transactions).length&&!fs.existsSync(path.join(supportRoot,'catalog.sqlite')))throw fail('存在未完成写入日志，但管理索引已缺失；请保留原库和日志，不自动覆盖');}
 let recoveryGuard,catalog;try{if(fs.existsSync(transactions)&&fs.readdirSync(transactions).length){if(isBusy())throw fail('请先退出 Eagle，再恢复未完成写入',409);recoveryGuard=acquireWriter(root,'.assetnest-writer-lock');}catalog=new Catalog(root,{supportRoot,external:true,recoverCheck:(...args)=>recoverCheck(isBusy,...args),...(fault?{fault}:{})});}finally{recoveryGuard?.release();}const stateFile=path.join(supportRoot,'eagle-state.json');let state={};
 try{
  if(fs.existsSync(stateFile))state=readJSON(stateFile);const identityFile=path.join(supportRoot,'library-id');if(!fs.existsSync(identityFile))durableWrite(identityFile,crypto.randomUUID());catalog.libraryId=fs.readFileSync(identityFile,'utf8').trim();catalog.kind='eagle';
  const persist=()=>{durableWrite(stateFile+'.tmp',JSON.stringify(state));fs.renameSync(stateFile+'.tmp',stateFile);};
  function refresh(force=false){if(catalog.blocked)throw fail('素材库恢复未完成，请重新打开：'+catalog.blocked,503);const scan=scanEagle(root);if(!force&&scan.fingerprint===catalog.externalFingerprint)return {changed:false,items:scan.records.length};
   const hashes=new Map(catalog.db.prepare('SELECT id,hash,metadata,file FROM items').all().map(r=>[r.id,r])),rows=scan.records.map(row=>({...row,hash:hashes.get(row.id)?.file===row.file&&state.lastFingerprint===scan.fingerprint?hashes.get(row.id).hash:payloadHash(filePayload(catalog.path(row.file)))}));if(scanEagle(root).fingerprint!==scan.fingerprint)throw fail('Eagle 库正在变化，请退出 Eagle 后重新打开',409);
   const db=catalog.db;db.exec('BEGIN IMMEDIATE');try{const ids=JSON.stringify(rows.map(r=>r.id));for(const table of ['items','item_sources','search_docs','image_features'])db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?))`).run(ids);db.exec('DELETE FROM folders;DELETE FROM folder_index;');for(const f of scan.folders){db.prepare('INSERT INTO folders VALUES(?,?)').run(f.id,JSON.stringify(f.raw));db.prepare('INSERT INTO folder_index VALUES(?,?)').run(f.id,f.parentId);}for(const row of rows){db.prepare('INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,file=excluded.file,thumb=excluded.thumb,hash=excluded.hash').run(row.id,row.metadata,row.file,row.thumb,row.hash);db.prepare('INSERT INTO item_sources VALUES(?,?,NULL) ON CONFLICT(id) DO UPDATE SET file_metadata=excluded.file_metadata').run(row.id,row.metadata);syncDocument(db,row);}if(state.lastFingerprint!==scan.fingerprint)db.prepare('INSERT INTO committed_transactions VALUES(?,?)').run('external-sync-'+crypto.randomUUID(),Date.now());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
   if(state.lastFingerprint!==scan.fingerprint)state.backupFingerprint=null;state.lastFingerprint=scan.fingerprint;catalog.externalFingerprint=scan.fingerprint;persist();return {changed:true,items:rows.length};
  }
  catalog.refreshExternal=refresh;refresh(true);
  const assertClosed=()=>{if(isBusy())throw fail('Eagle 正在运行。请退出 Eagle 后，再向此库采集或整理；浏览仍可使用',409);};
  const assertUnchanged=()=>{if(scanEagle(root).fingerprint!==catalog.externalFingerprint)throw fail('Eagle 原库已被外部修改，请点击“重新读取 Eagle 库”后再操作',409);};
  catalog.beforeBackup=()=>{assertClosed();assertUnchanged();};
  catalog.beforeCommit=()=>{if(catalog.blocked)throw fail('恢复未完成，已暂停写入',503);assertClosed();const guard=acquireWriter(root,'.assetnest-writer-lock');try{assertUnchanged();if(state.backupFingerprint!==catalog.externalFingerprint||!state.backup||!fs.existsSync(path.join(state.backup,'backup.json'))){const backup=createBackup(catalog);verifyBackup(backup.directory);assertUnchanged();state.backup=backup.directory;state.backupFingerprint=catalog.externalFingerprint;persist();}return ()=>guard.release();}catch(e){guard.release();throw e;}};
  catalog.beforePublish=roots=>{assertClosed();if(!roots)assertUnchanged();};catalog.transactionGuard=(...args)=>transactionGuard(catalog,...args);
  catalog.afterCommit=()=>{catalog.externalFingerprint=scanEagle(root).fingerprint;state.lastFingerprint=catalog.externalFingerprint;state.backupFingerprint=catalog.externalFingerprint;persist();};
  catalog.externalStatus=()=>{let busy;try{busy=isBusy();}catch{return {kind:'eagle',writable:false,reason:'无法确认 Eagle 运行状态',supportPath:supportRoot,backup:state.backup||null};}return {kind:'eagle',writable:!busy&&!catalog.blocked,reason:busy?'请退出 Eagle 后再写入原库':catalog.blocked||null,supportPath:supportRoot,backup:state.backup||null};};
  return catalog;
 }catch(e){catalog.close();throw e;}
}
