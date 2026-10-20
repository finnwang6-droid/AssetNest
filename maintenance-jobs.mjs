import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {durableWrite} from './storage.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const alive=pid=>{if(!Number.isInteger(pid))return false;try{process.kill(pid,0);return true;}catch{return false;}};
const error=(message,status=409)=>Object.assign(Error(message),{status});
export class MaintenanceJobs{
 constructor(catalog,transfers){this.catalog=catalog;this.transfers=transfers;this.jobs=new Map();this.root=path.join(catalog.supportRoot||catalog.root,'.assetnest-maintenance');this.load();}
 directory(id){if(!uuid.test(id))throw error('维护任务 ID 无效');const dir=path.resolve(this.root,id);if(path.dirname(dir)!==path.resolve(this.root))throw error('任务目录越界');return dir;}
 persist(job){const file=path.join(this.directory(job.id),'job.json');durableWrite(file+'.tmp',JSON.stringify(this.public(job)));fs.renameSync(file+'.tmp',file);}
 load(){if(!fs.existsSync(this.root))return;if(fs.lstatSync(this.root).isSymbolicLink())throw error('维护任务目录不能为链接');for(const name of fs.readdirSync(this.root)){if(!uuid.test(name))continue;const dir=this.directory(name);if(fs.lstatSync(dir).isSymbolicLink())throw error('维护任务目录不能为链接');try{const job=JSON.parse(fs.readFileSync(path.join(dir,'job.json'),'utf8'));if(job.id!==name||!['backup','integrity','rebuild'].includes(job.type))continue;this.jobs.set(name,job);if(['running','cancelling'].includes(job.status)){durableWrite(path.join(dir,'cancel'),'interrupted');job.status='interrupted';job.error='上次运行中断，原素材库未被修改；请重新运行任务';job.finishedAt=Date.now();job.cleanupPending=true;try{this.cleanInterrupted(job);}catch(e){job.cleanupError=e.message;}this.persist(job);}this.jobs.set(name,job);}catch{}}
 }
 defaultTarget(){return path.join(path.dirname(this.catalog.root),path.basename(this.catalog.root).replace(/\.library$/i,'')+'-重建-'+new Date().toISOString().replace(/[:.]/g,'-')+'.library');}
 validateTarget(target){if(typeof target!=='string'||!path.isAbsolute(target)||target.length>220)throw error('请输入新的素材库绝对路径',400);const dest=path.resolve(target),source=path.resolve(this.catalog.root),lower=p=>p.toLowerCase()+path.sep;if(lower(dest).startsWith(lower(source))||lower(source).startsWith(lower(dest)))throw error('重建目标必须与原素材库独立',400);if(fs.existsSync(dest))throw error('重建目标必须是尚不存在的新目录',400);const parent=path.dirname(dest);if(!fs.existsSync(parent)||fs.realpathSync(parent).toLowerCase()!==parent.toLowerCase())throw error('目标父目录必须存在且不能经过目录链接',400);return dest;}
 start(type,{target}={}){
  if(!['backup','integrity','rebuild'].includes(type))throw error('维护任务类型无效',400);this.transfers.assertIdle();this.catalog.beforeBackup?.();
  const id=crypto.randomUUID(),dir=this.directory(id);if(fs.existsSync(this.root)&&fs.lstatSync(this.root).isSymbolicLink())throw error('维护任务目录不能为链接');fs.mkdirSync(dir,{recursive:true});
  let destination=null;if(type==='rebuild')destination=this.validateTarget(target||this.defaultTarget());else if(type==='backup'){const backups=path.join(this.catalog.supportRoot||this.catalog.root,'backups');if(fs.existsSync(backups)&&fs.lstatSync(backups).isSymbolicLink())throw error('备份目录不能为链接');fs.mkdirSync(backups,{recursive:true});destination=path.join(backups,new Date().toISOString().replace(/[:.]/g,'-')+'-'+id.slice(0,8));}
  const stage=type==='rebuild'?destination+'.partial-'+id:path.join(dir,'output'),spec={id,type,source:this.catalog.root,dbFile:this.catalog.dbFile,supportRoot:this.catalog.supportRoot,stage,cancelFile:path.join(dir,'cancel')};
  durableWrite(path.join(dir,'spec.json'),JSON.stringify(spec));const job={id,type,status:'running',createdAt:Date.now(),phase:'准备任务',completed:0,entries:0,bytes:0,totalBytes:0,destination,stage};this.jobs.set(id,job);this.persist(job);
  job.promise=this.transfers.exclusive(()=>this.run(job,spec),'后台维护任务').catch(e=>{job.status='failed';job.error=e.message;job.finishedAt=Date.now();try{this.persist(job);}catch{};});return this.public(job);
 }
 public(job){return {id:job.id,type:job.type,status:job.status,createdAt:job.createdAt,finishedAt:job.finishedAt,phase:job.phase,completed:job.completed,entries:job.entries,bytes:job.bytes,totalBytes:job.totalBytes,destination:job.destination,error:job.error,result:job.result,workerPid:job.workerPid,cleanupPending:job.cleanupPending,cleanupError:job.cleanupError};}
 owns(id){return this.jobs.has(id);}
 list(){return [...this.jobs.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(j=>this.public(j));}
 get(id){const job=this.jobs.get(id);if(!job)throw error('维护任务不存在',404);return this.public(job);}
 cleanup(stage,id){if(!fs.existsSync(stage))return;if(fs.lstatSync(stage).isSymbolicLink())throw error('任务输出不能为链接');const job=this.jobs.get(id),expected=job.type==='rebuild'?job.destination+'.partial-'+id:path.join(this.directory(id),'output'),marker=path.join(stage,'.assetnest-job-owner');if(path.resolve(stage)!==path.resolve(expected)||fs.readFileSync(marker,'utf8')!==id)throw error('输出目录所有权校验失败，已保留现场');
  // Keep ownership proof until every payload entry is gone, so a locked file can be retried safely.
  for(const name of fs.readdirSync(stage))if(name!=='.assetnest-job-owner')fs.rmSync(path.join(path.resolve(stage),name),{recursive:true,force:true,maxRetries:5,retryDelay:100});
  fs.unlinkSync(marker);try{fs.rmdirSync(path.resolve(stage));}catch(e){durableWrite(marker,id);throw e;}
 }
 async run(job,spec){let result,workerError;const file=path.join(this.directory(job.id),'spec.json');try{
   const code=await new Promise((resolve,reject)=>{const child=fork(fileURLToPath(new URL('./maintenance-worker.mjs',import.meta.url)),[file],{execArgv:['--max-old-space-size=384'],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});job.child=child;job.workerPid=child.pid;try{this.persist(job);}catch(e){job.fatalError=e.message;child.kill();}let stderr='';child.stderr.on('data',data=>stderr=(stderr+data).slice(-1000));child.on('message',message=>{if(message.type==='progress'){Object.assign(job,{phase:message.phase,completed:message.completed,entries:message.total,bytes:message.bytes,totalBytes:message.totalBytes});try{this.persist(job);}catch(e){job.fatalError='无法保存维护任务进度：'+e.message;child.kill();}}else if(message.type==='result')result=message.result;else if(message.type==='error')workerError=message;});child.once('error',reject);child.once('close',code=>{job.child=null;job.workerPid=null;resolve({code,stderr});});});
   if(job.fatalError)throw error(job.fatalError);if(job.cancelRequested||workerError?.cancelled)throw Object.assign(error('任务已取消'),{cancelled:true});if(code.code!==0||!result)throw error(workerError?.error||code.stderr||'后台维护进程异常退出');
   this.catalog.beforeBackup?.();if(job.destination){if(fs.existsSync(job.destination))throw error('目标目录已出现，拒绝覆盖');if(fs.readFileSync(path.join(spec.stage,'.assetnest-job-owner'),'utf8')!==job.id)throw error('输出目录所有权校验失败');fs.renameSync(spec.stage,job.destination);try{fs.unlinkSync(path.join(job.destination,'.assetnest-job-owner'));}catch{}result={...result,directory:job.destination,...(job.type==='rebuild'?{target:job.destination}: {})};}
   job.result=result;job.completed=job.entries=result.fileCount??result.items??job.entries;if(result.bytes!==undefined)job.bytes=job.totalBytes=result.bytes;job.phase='完成';job.status='completed';
  }catch(e){job.status=e.cancelled||job.cancelRequested?'cancelled':'failed';job.phase=job.status==='cancelled'?'已取消':'未完成';job.error=(job.cancelError?job.cancelError+'；':'')+e.message;try{this.cleanup(spec.stage,job.id);}catch(cleanup){job.cleanupPending=true;job.cleanupError=cleanup.message;job.error+='；临时输出已保留：'+cleanup.message;}}
  finally{job.finishedAt=Date.now();try{this.persist(job);}catch(e){job.error=(job.error||'')+'；无法保存任务记录：'+e.message;}}
 }
 cancel(id){const job=this.jobs.get(id);if(!job)throw error('维护任务不存在',404);if(job.status==='running'){job.cancelRequested=true;job.status='cancelling';job.phase='正在取消，等待当前文件结束';try{durableWrite(path.join(this.directory(id),'cancel'),'cancel');}catch(e){job.cancelError='无法写入取消标记，已请求终止后台进程：'+e.message;job.child?.kill();}try{this.persist(job);}catch{};}return this.public(job);}
 cleanInterrupted(job){if(alive(job.workerPid))throw error('旧任务进程尚在退出，请稍后清理');const spec=JSON.parse(fs.readFileSync(path.join(this.directory(job.id),'spec.json'),'utf8'));if(spec.id!==job.id||path.resolve(spec.source)!==path.resolve(this.catalog.root))throw error('任务来源校验失败');this.cleanup(spec.stage,job.id);job.cleanupPending=false;job.cleanupError=null;}
 cleanupJob(id){const job=this.jobs.get(id);if(!job||!['interrupted','failed','cancelled'].includes(job.status))throw error('任务状态不允许清理');this.cleanInterrupted(job);this.persist(job);return this.public(job);}
 async close(){for(const job of this.jobs.values())if(['running','cancelling'].includes(job.status)){this.cancel(job.id);const timer=setTimeout(()=>job.child?.kill(),3000);timer.unref();await job.promise;clearTimeout(timer);}}
}
