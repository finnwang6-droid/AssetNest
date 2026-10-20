import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {encodeZip} from './zip-stream.mjs';
import {packExportEntries,preparePackDisk} from './eagle-pack.mjs';

const error=message=>Object.assign(Error(message),{status:409});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class Transfers{
 constructor(catalog){this.catalog=catalog;this.root=path.join(catalog.supportRoot||catalog.root,'.assetnest-transfers');this.jobs=new Map();this.busy=false;this.previews=new Map();this.timer=setInterval(()=>this.sweep(),60000);this.timer.unref();this.cleanAbandoned();}
 cleanAbandoned(){if(!fs.existsSync(this.root))return;if(fs.lstatSync(this.root).isSymbolicLink())throw error('任务缓存目录不能为链接');for(const name of fs.readdirSync(this.root))if(uuid.test(name))this.remove(name);}
 remove(id){if(!uuid.test(id))throw error('任务目录标识无效');const target=path.resolve(this.root,id);if(path.dirname(target)!==path.resolve(this.root))throw error('任务目录越界');if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink())fs.unlinkSync(target);else fs.rmSync(target,{recursive:true,force:true});}}
 directory(id){fs.mkdirSync(this.root,{recursive:true});if(fs.lstatSync(this.root).isSymbolicLink())throw error('任务缓存目录不能为链接');const directory=path.join(this.root,id);fs.mkdirSync(directory);return directory;}
 assertIdle(){if(this.busy)throw Object.assign(Error((this.busyLabel||'素材包任务')+'正在运行，请完成或取消任务后再修改素材库'),{status:this.busyLabel==='后台维护任务'?503:409});}
 async exclusive(fn,label='素材包任务'){this.assertIdle();this.busy=true;this.busyLabel=label;try{return await fn();}finally{this.busy=false;this.busyLabel=null;}}
 async preview(request,{check=()=>{},limit=4*1024**3}={}){
  return this.exclusive(async()=>{for(const old of this.previews.keys())this.cancelPreview(old);this.catalog.assertSpace(32*1024*1024);const id=crypto.randomUUID(),directory=this.directory(id),file=path.join(directory,'upload.eaglepack');try{let bytes=0;const owner=this.catalog;const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>limit)return done(Object.assign(Error('素材包超过 4GB'),{status:413}));if(bytes%(16*1024*1024)<chunk.length){try{owner.assertSpace(32*1024*1024);}catch(e){return done(e);}}done(null,chunk);}});await pipeline(request,meter,fs.createWriteStream(file,{flags:'wx'}));check();const plan=await preparePackDisk(owner,file,path.join(directory,'extracted'));check();this.previews.set(id,{plan,expires:Date.now()+5*60*1000});return {token:id,report:plan.report};}catch(e){this.remove(id);throw e;}});
 }
 takePreview(id){const preview=this.previews.get(id);if(!preview||preview.expires<Date.now()){this.cancelPreview(id);throw error('预检已过期，请重新选择素材包');}return preview.plan;}
 cancelPreview(id){if(!this.previews.has(id))return;this.previews.delete(id);this.remove(id);}
 startExport(ids){this.assertIdle();const entries=packExportEntries(this.catalog,ids),totalBytes=entries.reduce((n,e)=>n+e.data.length,0);this.catalog.assertSpace(totalBytes+entries.length*512);const id=crypto.randomUUID(),directory=this.directory(id),job={id,type:'export',status:'running',createdAt:Date.now(),entries:entries.length,completed:0,bytes:0,totalBytes,controller:new AbortController(),file:path.join(directory,'export.eaglepack'),token:crypto.randomBytes(24).toString('hex')};this.jobs.set(id,job);this.busy=true;
  job.promise=(async()=>{try{await pipeline(Readable.from(encodeZip(entries,{signal:job.controller.signal,onProgress:(completed,bytes)=>{job.completed=completed;job.bytes=bytes;}})),fs.createWriteStream(job.file,{flags:'wx'}),{signal:job.controller.signal});const fd=fs.openSync(job.file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}job.bytes=fs.statSync(job.file).size;job.status='completed';}catch(e){job.status=job.controller.signal.aborted?'cancelled':'failed';job.error=e.message;this.remove(id);}finally{job.finishedAt=Date.now();job.expires=Date.now()+10*60*1000;this.busy=false;}})();return this.public(job);
 }
 public(job){return {id:job.id,type:job.type,status:job.status,createdAt:job.createdAt,finishedAt:job.finishedAt,entries:job.entries,completed:job.completed,bytes:job.bytes,totalBytes:job.totalBytes,error:job.error,...(job.status==='completed'?{download:'/download/'+job.token,expires:job.expires}:{})};}
 list(){this.sweep();return {busy:this.busy,jobs:[...this.jobs.values()].reverse().map(job=>this.public(job))};}
 get(id){this.sweep();const job=this.jobs.get(id);if(!job)throw Object.assign(Error('任务已过期'),{status:404});return this.public(job);}
 cancel(id){const job=this.jobs.get(id);if(!job)throw Object.assign(Error('任务不存在'),{status:404});if(job.status==='running')job.controller.abort();else if(job.status==='completed'){this.remove(id);job.status='cancelled';}return this.public(job);}
 download(token){this.sweep();const job=[...this.jobs.values()].find(j=>j.token===token&&j.status==='completed');if(!job)throw Object.assign(Error('下载已过期，请重新导出'),{status:404});return job.file;}
 sweep(){for(const [id,p]of this.previews)if(p.expires<Date.now())this.cancelPreview(id);for(const [id,job]of this.jobs)if(job.expires<Date.now()){this.remove(id);this.jobs.delete(id);}}
 async close(){clearInterval(this.timer);for(const job of this.jobs.values())if(job.status==='running')job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));for(const id of this.previews.keys())this.cancelPreview(id);for(const id of this.jobs.keys())this.remove(id);this.jobs.clear();}
}
