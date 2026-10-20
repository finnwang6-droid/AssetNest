export function installCollector({api,refresh,openItem}){
 const link=document.createElement('link');link.rel='stylesheet';link.href='/collector.css';document.head.append(link);
 const bar=document.createElement('aside');bar.id='collector-status';bar.hidden=true;bar.setAttribute('aria-live','polite');
 const title=document.createElement('strong'),text=document.createElement('span'),view=document.createElement('button'),dismiss=document.createElement('button');view.textContent='查看采集记录';dismiss.id='collector-dismiss';dismiss.textContent='×';dismiss.title='关闭采集提示';dismiss.setAttribute('aria-label','关闭采集提示');bar.append(title,text,view,dismiss);document.body.append(bar);
 const dialog=document.createElement('dialog');dialog.id='collector-dialog';const heading=document.createElement('h2');heading.textContent='浏览器采集记录';const location=document.createElement('p'),list=document.createElement('div'),close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(heading,location,list,close);document.body.append(dialog);view.onclick=()=>dialog.showModal();
 const labels={running:'正在采集',paused:'采集已暂停','waiting-service':'等待本地服务','awaiting-duplicate':'等待处理重复图片',completed:'插件任务已结束',cancelled:'任务已取消',saved:'原图已保存',duplicate:'已使用已有素材',failed:'保存失败',downloading:'已收到图片，正在保存'};
 const history=document.createElement('button');history.id='collector-history';history.textContent='浏览器采集记录';history.onclick=()=>dialog.showModal();document.querySelector('#maintenance-jobs')?.before(history);
 let revision=-1,latest=null,dirty=false,busy=false,signature='',dismissTimer=null,autoHideDelay=0;
 function hide(){clearTimeout(dismissTimer);bar.hidden=true;}
 function scheduleHide(){clearTimeout(dismissTimer);if(autoHideDelay&&!bar.hidden)dismissTimer=setTimeout(hide,autoHideDelay);}
 dismiss.onclick=hide;bar.onmouseenter=()=>clearTimeout(dismissTimer);bar.onmouseleave=scheduleHide;
 document.addEventListener('input',e=>{if(e.target.closest('#inspector'))e.target.dataset.collectorEditing='true';});
 document.addEventListener('focusout',e=>{if(e.target.dataset)delete e.target.dataset.collectorEditing;});
 const canRefresh=()=>!document.querySelector('dialog[open]')&&!document.activeElement.dataset.collectorEditing&&!document.body.classList.contains('asset-dragging');
 async function update(){if(busy)return;busy=true;try{
  const result=await(await api('collector-status')).json();if(result.revision!==revision){
   const initial=revision<0;revision=result.revision;latest=result.events.find(e=>e.status!=='task');const job=result.job,pending=job&&['running','paused','waiting-service','awaiting-duplicate'].includes(job.status);
   const jobFailed=job?.error&&job.updatedAt>=(latest?.at||0);title.textContent=labels[pending?job.status:jobFailed?'failed':latest?.status]||'采集状态';
   const next=JSON.stringify([result.libraryId,job?.id,pending?job.status:jobFailed?'failed':latest?.status,pending?job.error:latest?.seq]);
   if(!job&&!latest)hide();else if(next!==signature){signature=next;autoHideDelay=pending?0:jobFailed||latest?.status==='failed'?10000:5000;bar.hidden=!!(initial&&!pending&&Date.now()-Math.max(latest?.at||0,job?.updatedAt||0)>=autoHideDelay);scheduleHide();}
   text.textContent=jobFailed&&!pending?job.error:pending?`${job.index} / ${job.total} · ${job.error||'请在浏览器采集任务面板中处理'}${job.targetLibraryId&&job.targetLibraryId!==result.libraryId?' · 目标为另一素材库':''}`:latest?`${latest.name} · ${latest.message||result.path}`:'尚无原图入库记录';
   location.textContent='当前素材库：'+result.path;list.replaceChildren();
   if(pending){const note=document.createElement('p');note.textContent='当前插件任务：'+labels[job.status]+'。'+(job.error||'打开浏览器中的拾素材任务面板，处理重复图片、继续或取消任务。');list.append(note);if(job.status==='paused'&&job.targetLibraryId&&job.targetLibraryId!==result.libraryId){const recover=document.createElement('button');recover.textContent='将待采集图片保存到当前素材库';recover.onclick=async()=>{recover.disabled=true;try{const r=await api('collector-recovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:job.id})});await r.json();recover.textContent='已安排恢复，等待插件连接…';}catch(e){recover.disabled=false;recover.textContent=e.message;}};list.append(recover);}}

   for(const event of result.events.filter(e=>e.status!=='task').slice(0,20)){const row=document.createElement('div'),label=document.createElement('p');row.className='collector-row';label.textContent=new Date(event.at).toLocaleTimeString()+' · '+(labels[event.status]||event.status)+' · '+event.name+(event.message?'：'+event.message:'');row.append(label);if(['saved','duplicate'].includes(event.status)){const button=document.createElement('button');button.textContent='定位图片';button.onclick=async()=>{dialog.close();await openItem(event);};row.append(button);}list.append(row);}
   if(!initial&&result.events.some(e=>['saved','duplicate'].includes(e.status)))dirty=true;
  }
  if(dirty&&canRefresh()){await refresh();dirty=false;}
 }catch{}finally{busy=false;}}
 void update();const timer=setInterval(update,2000);addEventListener('pagehide',()=>{clearInterval(timer);clearTimeout(dismissTimer);},{once:true});return {update};
}
