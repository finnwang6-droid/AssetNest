// Persist progress after each item. Replayed work is deduplicated by the local server.
export class CaptureQueue {
  constructor({read,write,capture,onChange=async()=>{}}) {
    this.read=read;
    this.write=write;
    this.capture=capture;
    this.onChange=onChange;
    this.active=null;
    this.mutations=Promise.resolve();
  }
  async save(job) { await this.write(job); try{await this.onChange(job);}catch{} return job; }
  mutate(fn) { const result=this.mutations.then(fn);this.mutations=result.catch(()=>{});return result; }
  enqueue(items,{target=null}={}) { return this.mutate(async()=>{
    if(!Array.isArray(items)||!items.length||items.length>100)throw Error('每个任务需要 1～100 张图片');
    if(JSON.stringify(items).length>5*1024*1024)throw Error('采集任务超过 5MB，请减少内嵌图片数量');
    for(const item of items){if(!item||typeof item.url!=='string'||! /^(https?:|blob:|data:image\/)/i.test(item.url))throw Error('任务包含不支持的图片地址');if(item.url.startsWith('data:')&&item.url.length>1024*1024)throw Error('内嵌图片或截图超过 1MB，请缩小截图区域');}
    const previous=await this.read();
    if(previous&&['running','paused','waiting-service','awaiting-duplicate'].includes(previous.status)){
     if(previous.status==='running'&&JSON.stringify(previous.target||null)===JSON.stringify(target)&&previous.items.length+items.length<=100&&JSON.stringify([...previous.items,...items]).length<=5*1024*1024){previous.items.push(...items.map(item=>previous.duplicatePolicy?{...item,duplicateMode:previous.duplicatePolicy}:item));previous.updatedAt=Date.now();return this.save(previous);}
     throw Object.assign(Error('已有旧任务尚未结束，新图片未提交。已打开任务面板，请先处理重复图片、继续或取消旧任务。'),{code:'QUEUE_BUSY'});
    }
    return this.save({id:crypto.randomUUID(),status:'running',items,target,index:0,added:0,duplicates:0,failures:[],results:[],createdAt:Date.now(),updatedAt:Date.now()});
  }); }
  control(action,{allRemaining=false,jobId}={}) { return this.mutate(async()=>{
    const job=await this.read();
    if(!job)throw Error('没有采集任务');
    if(jobId&&job.id!==jobId)throw Error('任务状态已变化，请刷新后重试');
    if(action==='pause'&&['running','waiting-service'].includes(job.status))job.status='paused';
    else if(action==='resume'&&['paused','waiting-service'].includes(job.status)){job.status='running';delete job.lastError;}
    else if(action==='cancel'&&['running','paused','waiting-service','awaiting-duplicate'].includes(job.status))job.status='cancelled';
    else if(['reuse','keep'].includes(action)&&job.status==='awaiting-duplicate'){job.items[job.index].duplicateMode=action;if(allRemaining){job.duplicatePolicy=action;for(const item of job.items.slice(job.index))item.duplicateMode=action;}job.status='running';delete job.duplicate;}
    else throw Error('任务当前状态不支持此操作');
    job.updatedAt=Date.now();return this.save(job);
  }); }
  retry({jobId,indices}={}) { return this.mutate(async()=>{
    const job=await this.read();
    if(jobId&&job?.id!==jobId)throw Error('任务状态已变化，请刷新后重试');
    if(job&&['running','paused','waiting-service','awaiting-duplicate'].includes(job.status))throw Error('请先结束当前任务，再重试失败项');
    const available=[...(job?.failures||[]),...(job?.deferredFailures||[])];
    if(!available.length)throw Error('没有失败的采集项');
    if(indices!==undefined&&(!Array.isArray(indices)||!indices.length||indices.some(n=>!Number.isInteger(n)||n<0||n>=available.length)))throw Error('失败项选择无效');
    const selected=indices===undefined?available.map((_,n)=>n):[...new Set(indices)],failures=selected.map(n=>available[n]);
    return this.save({id:crypto.randomUUID(),status:'running',items:failures.map(f=>structuredClone(f.item)),target:job.target||null,index:0,added:0,duplicates:0,failures:[],deferredFailures:available.filter((_,n)=>!selected.includes(n)),results:[],previousJobId:job.id,previousTarget:job.target||null,previousResults:job.results||[],retryIndices:failures.map(f=>f.index??null),createdAt:Date.now(),updatedAt:Date.now()});
  }); }
  retarget(jobId,target,folderIds=[]) {return this.mutate(async()=>{
    const previous=await this.read();
    if(previous?.id!==jobId||previous.status!=='paused'||previous.lastError?.code!=='LIBRARY_CHANGED')throw Error('任务状态已变化，请刷新后重试');
    if(!target?.server||!target.libraryId)throw Error('当前素材库未连接');
    const unsaved=[...previous.items.slice(previous.index),...(previous.failures||[]).map(f=>f.item),...(previous.deferredFailures||[]).map(f=>f.item)];
    const items=unsaved.map(item=>({...item,folderId:folderIds.includes(item.folderId)?item.folderId:'',duplicateMode:undefined}));
    if(!items.length)throw Error('没有尚未保存的图片');
    return this.save({id:crypto.randomUUID(),status:'running',items,target,index:0,added:0,duplicates:0,failures:[],results:[],previousJobId:previous.id,previousTarget:previous.target,previousResults:previous.results||[],previousFailures:[...(previous.failures||[]),...(previous.deferredFailures||[])],createdAt:Date.now(),updatedAt:Date.now()});
  });}
  run() {
    if(this.active)return this.active;
    this.active=this.drain();
    void this.active.then(()=>{this.active=null;void this.read().then(job=>{if(job?.status==='running')return this.run();}).catch(()=>{});},()=>{this.active=null;});
    return this.active;
  }
  async drain() {
    while(true){
      const job=await this.read();
      if(!job||job.status!=='running')return;
      if(job.index>=job.items.length){await this.mutate(async()=>{const latest=await this.read();if(latest?.id===job.id&&latest.status==='running')await this.save({...latest,status:'completed',updatedAt:Date.now()});});return;}
      const item=job.items[job.index];let result,failed;
      try{result=await this.capture(item,{jobId:job.id,index:job.index,key:job.id+':'+job.index,target:job.target||null});}catch(e){failed={message:String(e.message||e).slice(0,500),code:e.code||'CAPTURE_FAILED',retryable:!!e.retryable,pause:!!e.pause};}
      const sameJob=await this.mutate(async()=>{
      const latest=await this.read();
      if(!latest||latest.id!==job.id)return false;
      if(result?.duplicatePending&&latest.status!=='cancelled'){latest.duplicate={existing:result.item,incoming:{name:item.name||'网页图片'},index:job.index};latest.status='awaiting-duplicate';latest.updatedAt=Date.now();await this.save(latest);return true;}
      // Control actions may arrive while a download is in progress. Keep them.
      if(failed&&(failed.retryable||failed.pause)){latest.lastError={...failed,index:job.index};if(latest.status==='running')latest.status=failed.retryable?'waiting-service':'paused';await this.save(latest);return true;}
      if(failed)latest.failures.push({index:job.index,item,error:failed.message,code:failed.code});
      else if(result.duplicate)latest.duplicates++;
      else latest.added++;
      latest.results??=[];latest.results.push({index:job.index,name:item.name||'网页图片',status:failed?'failed':result.duplicate?'duplicate':'added',code:failed?.code||null,itemId:result?.item?.id||null,transport:result?.transport||null,sourceURL:/^(https?:|blob:)/i.test(item.url)?item.url:null,candidateSource:item.candidateSource||null,destination:result?.destination||null,verified:result?.verified===true,width:result?.item?.width||0,height:result?.item?.height||0,size:result?.item?.size||0});
      latest.index=job.index+1;latest.updatedAt=Date.now();
      await this.save(latest);
      return true;
      });
      if(!sameJob)return;
    }
  }
}
