import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {assetName} from './local-layout.mjs';
import {filePayload} from './file-payload.mjs';

export const watchExtensions=['jpg','jpeg','png','gif','webp','avif','svg','tif','tiff','psd','pdf','mp4','webm','mov','mp3','wav','ogg','flac','m4a','ttf','otf','woff','woff2'];
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const signature=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');
const overlap=(a,b)=>{a=path.resolve(a).toLowerCase()+path.sep;b=path.resolve(b).toLowerCase()+path.sep;return a.startsWith(b)||b.startsWith(a);};
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const maxBytes=128*1024**2;

export class WatchFolders{
 constructor(catalog,{blockedPaths=()=>[],isBusy=()=>false,onImported=()=>{},canRun=()=>true,interval=5000,stableMs=2000,autoStart=true}={}){
  Object.assign(this,{catalog,blockedPaths,isBusy,onImported,canRun,stableMs});this.stopped=false;this.active=null;this.current=null;
  this.stageRoot=path.join(catalog.supportRoot||catalog.root,'.assetnest-watch');
  catalog.db.exec(`CREATE TABLE IF NOT EXISTS watch_rules(id TEXT PRIMARY KEY,directory TEXT NOT NULL,recursive INTEGER NOT NULL,paused INTEGER NOT NULL,folder_id TEXT,tags TEXT NOT NULL,import_existing INTEGER NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,last_scan INTEGER,error TEXT);
   CREATE TABLE IF NOT EXISTS watch_entries(rule_id TEXT NOT NULL,relative TEXT NOT NULL,signature TEXT NOT NULL,observed INTEGER NOT NULL,state TEXT NOT NULL,item_id TEXT,hash TEXT,error TEXT,updated INTEGER NOT NULL,PRIMARY KEY(rule_id,relative));
   CREATE INDEX IF NOT EXISTS watch_entry_state ON watch_entries(rule_id,state,updated);UPDATE watch_entries SET state='waiting' WHERE state='importing';`);
  if(fs.existsSync(this.stageRoot)){if(fs.lstatSync(this.stageRoot).isSymbolicLink())throw fail('自动入库暂存目录不能为链接');for(const name of fs.readdirSync(this.stageRoot))if(/^[0-9a-f-]{36}\.tmp$/.test(name)){const file=path.join(this.stageRoot,name);if(fs.lstatSync(file).isFile())fs.unlinkSync(file);}}
  if(autoStart){this.timer=setInterval(()=>void this.tick(),interval);this.timer.unref();}
 }
 alive(){return !this.stopped&&this.catalog.db.isOpen;}
 rules(){return this.catalog.db.prepare('SELECT * FROM watch_rules ORDER BY rowid').all();}
 validateDirectory(directory,{id=null}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.length>220)throw fail('请输入现有文件夹的完整路径');
  const full=path.resolve(directory),stat=fs.lstatSync(full);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(full).toLowerCase()!==full.toLowerCase())throw fail('监控目录必须是普通文件夹，不能经过目录链接');
  if([this.catalog.root,this.catalog.supportRoot,...this.blockedPaths()].filter(Boolean).some(p=>overlap(full,p)))throw fail('监控目录必须与素材库、软件及辅助数据目录独立');
  let ancestor=full;for(;;){if(/\.library$/i.test(path.basename(ancestor))||fs.existsSync(path.join(ancestor,'images'))&&(fs.existsSync(path.join(ancestor,'metadata.json'))||fs.existsSync(path.join(ancestor,'catalog.sqlite'))))throw fail('不能监控素材库内部目录');const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  if(this.rules().some(rule=>rule.id!==id&&overlap(full,rule.directory)))throw fail('监控文件夹之间不能重复或嵌套');return full;
 }
 add(p){
  if(this.rules().length>=10)throw fail('本版最多添加 10 个监控文件夹');
  if(p.recursive!==undefined&&typeof p.recursive!=='boolean'||p.importExisting!==undefined&&typeof p.importExisting!=='boolean')throw fail('监控选项无效');
  const directory=this.validateDirectory(p.directory),folderId=p.folderId||null;if(folderId&&!this.catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(folderId))throw fail('目标分类不存在');
  if(!Array.isArray(p.tags||[])||(p.tags||[]).length>50||(p.tags||[]).some(t=>typeof t!=='string'||!t.trim()||t.length>100))throw fail('标签格式无效');
  const id=crypto.randomUUID();this.catalog.db.prepare('INSERT INTO watch_rules(id,directory,recursive,paused,folder_id,tags,import_existing) VALUES(?,?,?,0,?,?,?)').run(id,directory,Number(!!p.recursive),folderId,JSON.stringify([...new Set(p.tags||[])]),Number(!!p.importExisting));return this.status();
 }
 get(id){const rule=this.catalog.db.prepare('SELECT * FROM watch_rules WHERE id=?').get(id);if(!rule)throw fail('监控规则不存在',404);return rule;}
 configure(id,p){this.get(id);if(typeof p.paused!=='boolean')throw fail('暂停状态无效');this.catalog.db.prepare('UPDATE watch_rules SET paused=? WHERE id=?').run(Number(p.paused),id);if(p.paused&&this.current===id)this.controller?.abort();return this.status();}
 remove(id){this.get(id);if(this.current===id)this.controller?.abort();const db=this.catalog.db;db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM watch_entries WHERE rule_id=?').run(id);db.prepare('DELETE FROM watch_rules WHERE id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return this.status();}
 retry(id){this.get(id);this.catalog.db.prepare("UPDATE watch_entries SET state='waiting',error=NULL,observed=?,updated=? WHERE rule_id=? AND state='failed'").run(Date.now(),Date.now(),id);return this.status();}
 status(){const db=this.catalog.db;return {current:this.current,lastError:this.lastError||null,maxBytes,extensions:watchExtensions,rules:this.rules().map(rule=>({...rule,recursive:!!rule.recursive,paused:!!rule.paused,importExisting:!!rule.import_existing,initialized:!!rule.initialized,tags:JSON.parse(rule.tags),counts:Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM watch_entries WHERE rule_id=? GROUP BY state').all(rule.id).map(r=>[r.state,r.n])),recent:db.prepare("SELECT relative,state,item_id,error,updated FROM watch_entries WHERE rule_id=? AND state<>'baseline' ORDER BY updated DESC LIMIT 20").all(rule.id)}))};}
 async *walk(directory,recursive,prefix=''){
  const dir=await fs.promises.opendir(directory);for await(const entry of dir){if(!this.alive())return;const relative=prefix+entry.name,full=path.join(directory,entry.name);if(entry.isSymbolicLink()||entry.name.startsWith('.')||/\.library$/i.test(entry.name))continue;if(entry.isDirectory()&&recursive){if(fs.existsSync(path.join(full,'catalog.sqlite'))||fs.existsSync(path.join(full,'metadata.json'))&&fs.existsSync(path.join(full,'images')))continue;yield* this.walk(full,true,relative+'/');}else if(entry.isFile()&&watchExtensions.includes(path.extname(entry.name).slice(1).toLowerCase()))yield {relative,full};}
 }
 tick(){if(this.active||!this.alive()||!this.canRun())return this.active||Promise.resolve();this.active=this.scan().catch(e=>{this.lastError=e.message;}).finally(()=>{this.active=null;this.current=null;});return this.active;}
 async scan(){
  for(const initial of this.rules()){
   if(!this.alive())return;const rule=this.get(initial.id);if(rule.paused)continue;this.current=rule.id;
   try{
    this.validateDirectory(rule.directory,{id:rule.id});let count=0;
    for await(const {relative,full}of this.walk(rule.directory,!!rule.recursive)){
     if(!this.alive()||!this.catalog.db.prepare('SELECT id FROM watch_rules WHERE id=? AND paused=0').get(rule.id))break;
     if(++count>50000)throw fail('单个监控规则超过 50,000 个受支持文件，请缩小目录范围');
     const stat=await fs.promises.lstat(full);if(!stat.isFile()||stat.isSymbolicLink())continue;if(!this.alive())return;
     const old=this.catalog.db.prepare('SELECT * FROM watch_entries WHERE rule_id=? AND relative=?').get(rule.id,relative),sig=signature(stat);
     if(!old||old.signature!==sig){const baseline=!rule.initialized&&!rule.import_existing;this.catalog.db.prepare('INSERT INTO watch_entries VALUES(?,?,?,?,?,NULL,NULL,NULL,?) ON CONFLICT(rule_id,relative) DO UPDATE SET signature=excluded.signature,observed=excluded.observed,state=excluded.state,item_id=NULL,hash=NULL,error=NULL,updated=excluded.updated').run(rule.id,relative,sig,Date.now(),baseline?'baseline':'waiting',Date.now());}
     if(count%32===0)await pause();
    }
    if(!this.alive())return;const current=this.catalog.db.prepare('SELECT * FROM watch_rules WHERE id=?').get(rule.id);if(!current||current.paused)continue;
    this.catalog.db.prepare('UPDATE watch_rules SET initialized=1,last_scan=?,error=NULL WHERE id=?').run(Date.now(),rule.id);
    const ready=this.catalog.db.prepare("SELECT * FROM watch_entries WHERE rule_id=? AND state='waiting' AND observed<=? ORDER BY updated,relative LIMIT 50").all(rule.id,Date.now()-this.stableMs);
    for(const entry of ready){if(!this.alive()||this.isBusy())break;const live=this.catalog.db.prepare('SELECT * FROM watch_rules WHERE id=? AND paused=0').get(rule.id);if(!live)break;await this.ingest(live,entry);await pause();}
   }catch(e){if(this.alive())this.catalog.db.prepare('UPDATE watch_rules SET error=?,last_scan=? WHERE id=?').run(e.message.slice(0,500),Date.now(),rule.id);}
  }
 }
 safeFile(rule,relative){this.validateDirectory(rule.directory,{id:rule.id});const full=path.resolve(rule.directory,relative);if(!full.toLowerCase().startsWith(rule.directory.toLowerCase()+path.sep)||fs.realpathSync(full).toLowerCase()!==full.toLowerCase()||fs.lstatSync(full).isSymbolicLink()||!fs.statSync(full).isFile())throw fail('来源文件不再是监控目录中的普通文件');return full;}
 mark(entry,state,fields={}){if(this.alive())this.catalog.db.prepare('UPDATE watch_entries SET state=?,item_id=?,hash=?,error=?,updated=? WHERE rule_id=? AND relative=? AND signature=?').run(state,fields.itemId||null,fields.hash||null,fields.error||null,Date.now(),entry.rule_id,entry.relative,entry.signature);}
 async ingest(rule,entry){
  let staged;this.controller=new AbortController();const signal=this.controller.signal;
  try{
   const source=this.safeFile(rule,entry.relative),before=fs.statSync(source);if(signature(before)!==entry.signature)return;
   if(before.size>maxBytes)throw fail('超过自动入库单文件 128 MB 上限，请手动导入');if(!before.size)throw fail('文件为空');
   if(rule.folder_id&&!this.catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(rule.folder_id))throw fail('目标分类已被删除，请移除此规则后重新添加');
   this.catalog.assertSpace(before.size*2+16*1024**2);if(fs.existsSync(this.stageRoot)&&fs.lstatSync(this.stageRoot).isSymbolicLink())throw fail('自动入库暂存目录不能为链接');fs.mkdirSync(this.stageRoot,{recursive:true});staged=path.join(this.stageRoot,crypto.randomUUID()+'.tmp');
   this.mark(entry,'importing');const hasher=crypto.createHash('sha256');let size=0;const meter=new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>maxBytes)return done(fail('复制期间文件超过 128 MB'));hasher.update(chunk);done(null,chunk);}});
   await pipeline(fs.createReadStream(source),meter,fs.createWriteStream(staged,{flags:'wx'}),{signal});
   if(!this.alive()||signal.aborted)return;
   this.safeFile(rule,entry.relative);if(signature(fs.statSync(source))!==entry.signature||size!==before.size){this.mark(entry,'waiting');return;}
   const live=this.catalog.db.prepare('SELECT * FROM watch_rules WHERE id=? AND paused=0').get(rule.id);if(!live)return;if(this.isBusy()){this.mark(entry,'waiting');return;}
   if(live.folder_id&&!this.catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(live.folder_id))throw fail('目标分类已被删除，请重新添加规则');
   const hash=hasher.digest('hex'),receiptKey='watch-'+crypto.createHash('sha256').update(rule.id+'\0'+entry.relative+'\0'+entry.signature).digest('hex'),db=this.catalog.db;
   if(db.prepare('SELECT key FROM purged_receipts WHERE key=?').get(receiptKey)){this.mark(entry,'skipped',{error:'该次入库的素材已被彻底删除，保留来源文件，不自动重新导入'});return;}
   const receipt=db.prepare('SELECT result FROM capture_receipts WHERE key=?').get(receiptKey);if(receipt){const result=JSON.parse(receipt.result);if(!this.catalog.row(result.itemId))throw fail('已提交入库记录对应的素材缺失，请检查素材库');this.mark(entry,'imported',{itemId:result.itemId,hash});return;}
   const existing=db.prepare('SELECT id,file,metadata FROM items WHERE hash=? ORDER BY id LIMIT 1').get(hash);
   if(existing){
    const original=this.catalog.path(existing.file);if(!fs.existsSync(original)||fs.lstatSync(original).isSymbolicLink())throw fail('已有相同素材的原文件缺失或无效，请先检查素材库');
    const check=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(original,{signal}))check.update(chunk);
    if(!this.alive()||signal.aborted)return;if(!db.prepare('SELECT id FROM watch_rules WHERE id=? AND paused=0').get(rule.id)||this.isBusy()){this.mark(entry,'waiting');return;}
    if(check.digest('hex')!==hash||!this.catalog.row(existing.id))throw fail('已有相同素材的原文件校验失败，请先检查素材库');
    this.mark(entry,'duplicate',{itemId:existing.id,hash,error:JSON.parse(this.catalog.row(existing.id).metadata).isDeleted?'相同文件已在回收站，未自动恢复':'相同内容已在素材库，已跳过'});return;
   }
   const id=this.catalog.allocate(),ext=path.extname(entry.relative).slice(1).toLowerCase(),name=assetName(path.basename(entry.relative,path.extname(entry.relative)),this.catalog.root,id,ext),now=Date.now(),metadata={id,name,ext,tags:JSON.parse(live.tags),folders:live.folder_id?[live.folder_id]:[],url:'',annotation:'',isDeleted:false,size,noThumbnail:true,btime:now,mtime:now,lastModified:now,modificationTime:now,importMethod:'watch-folder',sourcePath:source};
   this.catalog.commit({items:[{row:{id,metadata:JSON.stringify(metadata),file:id+'.info/'+name+'.'+ext,thumb:null,hash},source:{file_metadata:JSON.stringify(metadata),pack_id:null},files:{[name+'.'+ext]:filePayload(staged)}}],receipt:{key:receiptKey,requestHash:hash,result:{itemId:id,duplicate:false}}});
   this.mark(entry,'imported',{itemId:id,hash});try{this.onImported(this.catalog.row(id));}catch{}
  }catch(e){if(this.alive()){if(signal.aborted||this.isBusy())this.mark(entry,'waiting');else this.mark(entry,'failed',{error:e.message.slice(0,500)});}}
  finally{this.controller=null;if(this.alive())this.catalog.db.prepare("UPDATE watch_entries SET state='waiting' WHERE rule_id=? AND relative=? AND signature=? AND state='importing'").run(entry.rule_id,entry.relative,entry.signature);if(staged&&fs.existsSync(staged)){try{fs.unlinkSync(staged);}catch(e){this.lastError='暂存文件清理失败：'+e.message;}}}
 }
 async stop(){this.stopped=true;clearInterval(this.timer);this.controller?.abort();await this.active;}
}
