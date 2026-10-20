// Runs in the isolated world. Page content never receives the connection key.
export function pageFeedback(message){
 const old=document.getElementById('assetnest-capture-feedback');old?.remove();
 const host=document.createElement('div');host.id='assetnest-capture-feedback';
 host.style.cssText='all:initial;position:fixed;right:22px;bottom:22px;z-index:2147483647';
 const root=host.attachShadow({mode:'closed'}),style=document.createElement('style');
 style.textContent='section{display:flex;align-items:center;gap:12px;width:320px;padding:14px;background:#252629;color:#fff;border:1px solid #525358;border-radius:12px;box-shadow:0 5px 22px #0005;font:13px "Segoe UI","Microsoft YaHei",sans-serif}button{color:inherit;background:transparent;border:0;cursor:pointer;text-align:left;font:inherit}strong{display:block;margin-bottom:5px}small{display:block;color:#ccc;line-height:1.5}img{width:42px;height:42px;object-fit:contain;border-radius:5px}.close{align-self:flex-start;font-size:18px}';
 const box=document.createElement('section'),button=document.createElement('button'),title=document.createElement('strong'),detail=document.createElement('small'),close=document.createElement('button');
 title.textContent=message.title;detail.textContent=message.detail;button.append(title,detail);button.onclick=()=>{chrome.runtime.sendMessage({type:'open-results'}).catch(()=>{});host.remove();};close.textContent='×';close.className='close';close.setAttribute('aria-label','关闭');close.onclick=()=>host.remove();
 if(message.thumbnail?.startsWith('data:image/')){const img=document.createElement('img');img.src=message.thumbnail;box.append(img);}box.append(button,close);root.append(style,box);document.documentElement.append(host);
 if(!message.persistent)setTimeout(()=>host.remove(),9000);
}
export function jobFeedback(job){
 if(job.status==='awaiting-duplicate')return {title:'发现重复图片',detail:'素材库中已有相同图片。点击选择使用已有素材或保留两者。',persistent:true};
 if(job.status==='waiting-service'||job.status==='paused')return {title:'采集尚未保存',detail:job.lastError?.message||'任务已暂停，点击查看并继续。',persistent:true};
 if(job.status==='completed')return {title:job.failures.length?'采集结束，部分图片未保存':'采集完成',detail:`新增 ${job.added} 张 · 重复 ${job.duplicates} 张 · 失败 ${job.failures.length} 张。点击查看结果。`,persistent:!!job.failures.length};
 if(job.status==='cancelled')return {title:'采集已取消',detail:`已处理 ${job.index} / ${job.items.length} 张，已保存素材保留。`};
 return {title:'正在保存到拾素材',detail:`正在处理 ${job.index+1} / ${job.items.length} 张，完成后会提示。`};
}
