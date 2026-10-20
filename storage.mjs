import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setupSearch,syncDocument} from './search.mjs';
import {libraryFiles,rootDocuments,assetName} from './local-layout.mjs';
import {writePayload,filePayload,payloadHash} from './file-payload.mjs';

export const newId=()=>Date.now().toString(36).toUpperCase()+crypto.randomBytes(5).toString('hex').toUpperCase();
export const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(id);
export const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function durableWrite(file,bytes){const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function removeOwned(root,target){const resolved=path.resolve(target);if(!resolved.startsWith(path.resolve(root)+path.sep))throw fail('恢复路径越界');fs.rmSync(resolved,{recursive:true,force:true});}
function pidAlive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
export function acquireWriter(root,name='.writer-lock'){
 const file=path.join(root,name),token=crypto.randomUUID();let fd;
 try{fd=fs.openSync(file,'wx');}catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('素材库锁损坏，请先检查，不自动覆盖');}if(!Number.isInteger(owner.pid)||pidAlive(owner.pid))throw fail('素材库正在使用，请关闭其他服务或维护进程');fs.unlinkSync(file);fd=fs.openSync(file,'wx');}
 fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));fs.fsyncSync(fd);
 return {release(){if(fd===undefined)return;fs.closeSync(fd);fd=undefined;try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file);}catch{}}};
}

export class Catalog {
 constructor(root,{fault=()=>{},space=()=>fs.statfsSync(root),supportRoot=null,external=false,recoverCheck=null}={}){
  this.root=path.resolve(root);this.supportRoot=path.resolve(supportRoot||root);this.external=external;this.dbFile=path.join(this.supportRoot,'catalog.sqlite');this.images=path.join(this.root,'images');this.transactions=path.join(this.root,external?'.assetnest-transactions':'.transactions');this.fault=fault;this.space=space;this.recoverCheck=recoverCheck;
  if(!external&&!fs.existsSync(path.join(this.root,'catalog.sqlite'))&&fs.existsSync(path.join(this.root,'metadata.json')))throw fail('请通过素材库管理直接添加 Eagle .library，或选择拾素材库');
  if(external){if(!fs.existsSync(this.images))throw fail('Eagle 素材目录不存在');fs.mkdirSync(this.supportRoot,{recursive:true});}else{fs.mkdirSync(this.images,{recursive:true});fs.mkdirSync(this.transactions,{recursive:true});}
  this.guard=acquireWriter(this.supportRoot);
  try{
   this.db=new DatabaseSync(this.dbFile);
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, file TEXT NOT NULL, thumb TEXT, hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS item_hash ON items(hash);
    CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS item_sources(id TEXT PRIMARY KEY, file_metadata TEXT, pack_id TEXT);
    CREATE TABLE IF NOT EXISTS folder_index(id TEXT PRIMARY KEY,parent_id TEXT);
    CREATE TABLE IF NOT EXISTS packs(id TEXT PRIMARY KEY,envelope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS committed_transactions(id TEXT PRIMARY KEY,committed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS import_reports(id TEXT PRIMARY KEY,report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_receipts(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purged_receipts(key TEXT PRIMARY KEY,purged_at INTEGER NOT NULL);`);
   this.recovery=this.recover();this.migrateLegacy();setupSearch(this.db);
   if(!external&&libraryFiles.some(name=>!fs.existsSync(path.join(this.root,name)))){const inject=this.fault;this.fault=()=>{};try{this.commit({});}finally{this.fault=inject;}}
  }catch(e){this.close();throw e;}
 }
 close(){if(this.db?.isOpen)this.db.close();this.guard?.release();}
 path(relative){const full=path.resolve(this.images,relative);if(!full.startsWith(this.images+path.sep))throw fail('素材路径越界');return full;}
 migrateLegacy(){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   for(const row of this.db.prepare('SELECT * FROM items WHERE id NOT IN (SELECT id FROM item_sources)').all()){
    const file=path.join(this.images,row.id+'.info','metadata.json');const disk=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):JSON.parse(row.metadata);
    this.db.prepare('INSERT INTO item_sources VALUES(?,?,NULL)').run(row.id,JSON.stringify(disk));
   }
   for(const row of this.db.prepare('SELECT * FROM folders WHERE id NOT IN (SELECT id FROM folder_index)').all()){
    const raw=JSON.parse(row.metadata),parent=raw.parentId||null;delete raw.parentId;
    this.db.prepare('UPDATE folders SET metadata=? WHERE id=?').run(JSON.stringify(raw),row.id);
    this.db.prepare('INSERT INTO folder_index VALUES(?,?)').run(row.id,parent);
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 recover(){
  const results=[];
  if(!fs.existsSync(this.transactions))return results;
  for(const name of fs.readdirSync(this.transactions)){
   if(!/^[0-9a-f-]{36}$/.test(name))throw fail('发现无法识别的恢复目录：'+name);
   const tx=path.join(this.transactions,name),manifest=path.join(tx,'manifest.json');if(fs.lstatSync(tx).isSymbolicLink())throw fail('恢复目录不能为链接');
   if(!fs.existsSync(manifest)){removeOwned(this.transactions,tx);results.push({id:name,action:'discarded-unpublished-staging'});continue;}
   const m=JSON.parse(fs.readFileSync(manifest,'utf8'));
   if(m.id!==name||m.version!==1||!Array.isArray(m.operations)||m.operations.some(o=>!validId(o.id)||!['new','replace','delete'].includes(o.kind)))throw fail('恢复日志格式无效：'+name);
   if(m.rootOperations&&(!Array.isArray(m.rootOperations)||m.rootOperations.some(o=>!libraryFiles.includes(o.name)||typeof o.existed!=='boolean')))throw fail('根文件恢复日志无效');
   const committed=!!this.db.prepare('SELECT id FROM committed_transactions WHERE id=?').get(name);
   if(this.recoverCheck)this.recoverCheck(this,m,tx,committed);
   if(!committed){
    for(const op of [...(m.rootOperations||[])].reverse()){const target=path.join(this.root,op.name),backup=path.join(tx,'root-backup',op.name),staged=path.join(tx,'root-staged',op.name);if(fs.existsSync(backup)){if(fs.existsSync(target))fs.unlinkSync(target);fs.renameSync(backup,target);}else if(!op.existed&&!fs.existsSync(staged)&&fs.existsSync(target))fs.unlinkSync(target);}
    for(const op of [...m.operations].reverse()){
     const target=path.join(this.images,op.id+'.info'),backup=path.join(tx,'backup',op.id+'.info'),staged=path.join(tx,'staged',op.id+'.info');
     if(['replace','delete'].includes(op.kind)&&fs.existsSync(backup)){if(fs.existsSync(target))removeOwned(this.images,target);fs.renameSync(backup,target);}
     else if(op.kind==='new'&&!fs.existsSync(staged)&&fs.existsSync(target))removeOwned(this.images,target);
    }
   }
   removeOwned(this.transactions,tx);results.push({id:name,action:committed?'finished-committed-cleanup':'rolled-back-uncommitted'});
  }
  return results;
 }
 assertSpace(bytes){const s=this.space();const free=Number(s.bavail)*Number(s.bsize);const required=bytes+Math.max(16*1024*1024,Math.ceil(bytes*0.1));if(free<required)throw fail(`磁盘空间不足：需要约 ${Math.ceil(required/1048576)}MB，可用 ${Math.floor(free/1048576)}MB`,507);return {requiredBytes:required,availableBytes:free};}
 row(id){return this.db.prepare('SELECT * FROM items WHERE id=?').get(id);}
 source(id){return this.db.prepare('SELECT * FROM item_sources WHERE id=?').get(id);}
 folders(){return this.db.prepare('SELECT f.*,i.parent_id FROM folders f LEFT JOIN folder_index i ON f.id=i.id').all();}
 allocate(reserved=new Set()){let id;do{id=newId();}while(reserved.has(id)||this.row(id)||fs.existsSync(path.join(this.images,id+'.info')));reserved.add(id);return id;}
 commit(plan){const release=this.beforeCommit?.();try{const result=this.commitPlan(plan);try{this.afterCommit?.();}catch(e){this.blocked='写入已完成，但外部库状态更新失败，请重新打开素材库：'+e.message;}return result;}finally{release?.();}}
 commitPlan({items=[],folders=[],deleteFolders=[],deleteItems=[],pack=null,packs=[],report=null,receipt=null}){
  if(this.blocked)throw fail('素材库恢复未完成，已暂停写入：'+this.blocked,503);
  const id=crypto.randomUUID(),tx=path.join(this.transactions,id);let committed=false;let begun=false;
  const renames=new Map();items=items.map(item=>{const previous=this.row(item.row.id);if(!previous||item.files)return item;const before=JSON.parse(previous.metadata),after=JSON.parse(item.row.metadata);if(before.name===after.name)return item;const name=assetName(after.name,this.root,after.id,after.ext);if(name!==after.name)throw fail('素材名称包含无效字符、保留名称或超出本地路径长度');const file=after.id+'.info/'+name+'.'+after.ext,thumb=item.row.thumb?after.id+'.info/'+name+'_thumbnail.png':null;renames.set(after.id,{fromFile:path.basename(previous.file),toFile:path.basename(file),fromThumb:previous.thumb?path.basename(previous.thumb):null,toThumb:thumb?path.basename(thumb):null});return {...item,row:{...item.row,file,thumb}};});
  if(!Array.isArray(deleteItems)||new Set(deleteItems).size!==deleteItems.length)throw fail('彻底删除列表无效');for(const id of deleteItems){if(!validId(id)||items.some(i=>i.row.id===id))throw fail('彻底删除列表冲突');const row=this.row(id);if(!row||JSON.parse(row.metadata).isDeleted!==true)throw fail('只能彻底删除回收站内的素材');}
  const operations=items.map(i=>({id:i.row.id,kind:this.row(i.row.id)?'replace':'new'})).concat(deleteItems.map(id=>({id,kind:'delete'}))),rootOperations=libraryFiles.map(name=>({name,existed:fs.existsSync(path.join(this.root,name))}));
  let required=0;for(const i of items){if(i.files)for(const v of Object.values(i.files))required+=v.length;else{for(const name of fs.readdirSync(path.join(this.images,i.row.id+'.info')))required+=fs.statSync(path.join(this.images,i.row.id+'.info',name)).size;}}
  if(!deleteItems.length||items.length)this.assertSpace(required+Buffer.byteLength(JSON.stringify({folders,pack,packs,report})));this.fault('before-stage');
  fs.mkdirSync(path.join(tx,'staged'),{recursive:true});fs.mkdirSync(path.join(tx,'backup'));fs.mkdirSync(path.join(tx,'root-staged'));fs.mkdirSync(path.join(tx,'root-backup'));
  try{
   for(const item of items){
    if(!validId(item.row.id))throw fail('无效素材 ID');const stage=path.join(tx,'staged',item.row.id+'.info');
    if(item.files){fs.mkdirSync(stage);for(const [name,bytes]of Object.entries(item.files)){if(path.basename(name)!==name||name==='.'||name==='..')throw fail('暂存文件名无效');writePayload(path.join(stage,name),bytes);}}
    else{fs.cpSync(path.join(this.images,item.row.id+'.info'),stage,{recursive:true});for(const name of fs.readdirSync(stage)){const fd=fs.openSync(path.join(stage,name),'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
    const rename=renames.get(item.row.id);if(rename){const pairs=[[rename.fromFile,rename.toFile],...(rename.fromThumb?[[rename.fromThumb,rename.toThumb]]:[])];for(let n=0;n<pairs.length;n++)fs.renameSync(path.join(stage,pairs[n][0]),path.join(stage,'.rename-'+n));for(let n=0;n<pairs.length;n++){if(fs.existsSync(path.join(stage,pairs[n][1])))throw fail('重命名目标与素材附属文件冲突');fs.renameSync(path.join(stage,'.rename-'+n),path.join(stage,pairs[n][1]));}}
    const disk=item.source?.file_metadata??item.row.metadata;
    durableWrite(path.join(stage,'metadata.json'),disk);this.fault('after-stage-item');
   }
   const manifest={version:1,id,operations,rootOperations};if(this.transactionGuard)manifest.externalGuard=this.transactionGuard('stage',manifest,tx);
   durableWrite(path.join(tx,'manifest.tmp'),JSON.stringify(manifest));fs.renameSync(path.join(tx,'manifest.tmp'),path.join(tx,'manifest.json'));this.fault('after-journal');this.beforePublish?.(false);
   this.db.exec('BEGIN IMMEDIATE');begun=true;
   for(const op of operations){
    const target=path.join(this.images,op.id+'.info');
    if(['replace','delete'].includes(op.kind)&&fs.existsSync(target))fs.renameSync(target,path.join(tx,'backup',op.id+'.info'));
    else if(op.kind!=='delete'&&fs.existsSync(target))throw fail('目标素材目录已存在，拒绝覆盖：'+op.id);
    this.fault('after-backup');if(op.kind!=='delete')fs.renameSync(path.join(tx,'staged',op.id+'.info'),target);this.fault('after-publish-item');
   }
   for(const item of items){const r=item.row,s=item.source;this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,file=excluded.file,thumb=excluded.thumb,hash=excluded.hash').run(r.id,r.metadata,r.file,r.thumb,r.hash);this.db.prepare('INSERT INTO item_sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET file_metadata=excluded.file_metadata,pack_id=excluded.pack_id').run(r.id,s?.file_metadata??null,s?.pack_id??null);}
   for(const id of deleteItems){for(const table of ['items','item_sources','search_docs','image_features','preview_tasks'])if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))this.db.prepare('DELETE FROM '+table+' WHERE id=?').run(id);this.db.prepare("INSERT OR IGNORE INTO purged_receipts SELECT key,? FROM capture_receipts WHERE json_extract(result,'$.itemId')=?").run(Date.now(),id);this.db.prepare("DELETE FROM capture_receipts WHERE json_extract(result,'$.itemId')=?").run(id);}
   for(const f of folders){this.db.prepare('INSERT INTO folders VALUES(?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata').run(f.id,JSON.stringify(f.raw));this.db.prepare('INSERT INTO folder_index VALUES(?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id').run(f.id,f.parentId??null);}
   for(const id of deleteFolders){this.db.prepare('DELETE FROM folder_index WHERE id=?').run(id);this.db.prepare('DELETE FROM folders WHERE id=?').run(id);}
   for(const p of pack?[...packs,pack]:packs)this.db.prepare('INSERT INTO packs VALUES(?,?)').run(p.id,JSON.stringify(p.envelope));
   if(report)this.db.prepare('INSERT INTO import_reports VALUES(?,?)').run(report.id,JSON.stringify(report));
   if(receipt)this.db.prepare('INSERT INTO capture_receipts VALUES(?,?,?)').run(receipt.key,receipt.requestHash,JSON.stringify(receipt.result));
   for(const item of items)syncDocument(this.db,item.row);
   for(const [name,value]of Object.entries(rootDocuments(this,items,deleteItems)))durableWrite(path.join(tx,'root-staged',name),JSON.stringify(value));
   if(this.transactionGuard){manifest.externalGuard=this.transactionGuard('roots',manifest,tx);durableWrite(path.join(tx,'manifest.tmp'),JSON.stringify(manifest));fs.renameSync(path.join(tx,'manifest.tmp'),path.join(tx,'manifest.json'));}this.beforePublish?.(true);
   this.fault('before-root-publish');for(const op of rootOperations){if(op.existed)fs.renameSync(path.join(this.root,op.name),path.join(tx,'root-backup',op.name));fs.renameSync(path.join(tx,'root-staged',op.name),path.join(this.root,op.name));this.fault('after-root-publish');}
   this.fault('before-db-commit');this.db.prepare('INSERT INTO committed_transactions VALUES(?,?)').run(id,Date.now());this.db.exec('COMMIT');begun=false;committed=true;this.fault('after-db-commit');
   removeOwned(this.transactions,tx);return id;
  }catch(e){
   if(begun)this.db.exec('ROLLBACK');
   if(committed){this.recovery.push({id,action:'cleanup-pending'});return id;}
   try{this.recovery.push(...this.recover());}catch(recoveryError){this.blocked=recoveryError.message;throw fail(`提交失败且恢复未完成，请停止写入：${recoveryError.message}`);}
   throw e;
  }
 }
 updateItem(id,patch){
  const row=this.row(id);if(!row)throw fail('素材不存在',404);
  const m=JSON.parse(row.metadata),s=this.source(id),disk=s?.file_metadata?JSON.parse(s.file_metadata):null;
  const changes={};for(const k of ['name','tags','annotation','folders','star','isDeleted','assetnestRegions'])if(patch[k]!==undefined)changes[k]=patch[k];
  if(changes.assetnestRegions!==undefined){const regions=changes.assetnestRegions;if(!Array.isArray(regions)||regions.length>200||regions.some(r=>!r||!['x','y','width','height'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1.000001||r.y+r.height>1.000001||typeof r.text!=='string'||r.text.length>4000))throw fail('区域注释格式无效');changes.assetnestRegions=regions.map(({x,y,width,height,text})=>({x,y,width,height,text}));}
  if(changes.name!==undefined&&(typeof changes.name!=='string'||!changes.name.trim()||/[\/\\\x00]/.test(changes.name)||changes.name.length>1000))throw fail('素材名称无效');
  for(const k of ['tags','folders'])if(changes[k]!==undefined&&(!Array.isArray(changes[k])||changes[k].some(v=>typeof v!=='string')))throw fail(k+' 格式无效');
  if(changes.folders?.some(id=>!this.db.prepare('SELECT id FROM folders WHERE id=?').get(id)))throw fail('目标文件夹不存在');
  if(changes.annotation!==undefined&&typeof changes.annotation!=='string')throw fail('注释格式无效');
  if(changes.star!==undefined&&(!Number.isInteger(changes.star)||changes.star<0||changes.star>5))throw fail('评分需要为 0～5');
  if(changes.isDeleted!==undefined&&typeof changes.isDeleted!=='boolean')throw fail('回收站状态无效');
  changes.lastModified=Date.now();Object.assign(m,changes);if(disk)Object.assign(disk,changes);
  this.commit({items:[{row:{...row,metadata:JSON.stringify(m)},source:{file_metadata:disk?JSON.stringify(disk):null,pack_id:s?.pack_id??null}}]});return m;
 }
 integrity(){
  const issues=[];for(const r of this.db.prepare('SELECT * FROM items').all()){
   for(const file of [r.file,r.thumb].filter(Boolean))if(!fs.existsSync(this.path(file)))issues.push({id:r.id,kind:'missing-file',file});
   if(fs.existsSync(this.path(r.file))&&payloadHash(filePayload(this.path(r.file)))!==r.hash)issues.push({id:r.id,kind:'content-hash-mismatch'});
   const s=this.source(r.id),meta=path.join(this.images,r.id+'.info','metadata.json');try{const expected=s?.file_metadata??r.metadata;if(JSON.stringify(JSON.parse(fs.readFileSync(meta,'utf8').replace(/^\uFEFF/,'')))!==JSON.stringify(JSON.parse(expected)))issues.push({id:r.id,kind:'metadata-mismatch'});}catch{issues.push({id:r.id,kind:'metadata-unreadable'});}
  }
  for(const dir of fs.readdirSync(this.images)){if(dir.endsWith('.info')&&!this.row(dir.slice(0,-5)))issues.push({kind:'unindexed-directory',directory:dir});}
  const folders=this.folders(),folderIds=new Set(folders.map(f=>f.id));
  for(const r of this.db.prepare('SELECT id,metadata FROM items').all())for(const id of JSON.parse(r.metadata).folders||[])if(!folderIds.has(id))issues.push({id:r.id,kind:'missing-folder-reference',folderId:id});
  for(const f of folders){if(f.parent_id&&!folderIds.has(f.parent_id))issues.push({id:f.id,kind:'missing-parent-folder',parentId:f.parent_id});let current=f;const seen=new Set();while(current){if(seen.has(current.id)){issues.push({id:f.id,kind:'folder-cycle'});break;}seen.add(current.id);current=folders.find(p=>p.id===current.parent_id);}}
  return {healthy:issues.length===0,items:this.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,issues,recovery:this.recovery};
 }
}
