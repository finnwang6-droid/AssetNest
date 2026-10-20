if(new URLSearchParams(location.search).has('results'))document.body.classList.add('results-page');
const $=s=>document.querySelector(s);let images=[],selected=new Set(),tab,currentJob=null,lastScan=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const send=async m=>{const r=await chrome.runtime.sendMessage(m);if(!r)throw Error('插件后台未响应，请在扩展管理中重新加载拾素材');if(!r.ok)throw Object.assign(Error(r.error),{code:r.code});return r.data;};
let duplicateIndex='';
const act=fn=>async(...args)=>{try{await fn(...args);}catch(e){$('#status').textContent=e.message;}};
const tags=()=>$('#tags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
function chosen(i){return i.chosenURL||($('#quality').value==='current'?i.currentUrl:i.url)||i.url;}
function render(){const min=Number($('#min-size').value),list=images.filter(i=>Math.max(i.width,i.height)>=min);$('#images').innerHTML=list.map(i=>{const index=images.indexOf(i),url=chosen(i);return `<div class="image-choice"><button class="image ${selected.has(i.id)?'selected':''}" data-index="${index}" title="${esc(i.name)}"><img src="${esc(i.previewUrl||i.currentUrl||i.url)}" alt="${esc(i.name)}"><small>${i.width||'?'} × ${i.height||'?'} 页面</small><span>${selected.has(i.id)?'✓':'＋'}</span></button><select aria-label="图片候选" data-candidate="${index}">${(i.candidates||[{url:i.url,source:'current'}]).map(c=>`<option value="${esc(c.url)}" ${c.url===url?'selected':''}>${esc(c.source)}${c.width?' · '+c.width+'w':c.density>1?' · '+c.density+'x':''}</option>`).join('')}</select></div>`;}).join('');$('#count').textContent=`${list.length} 张图片 · 已选 ${selected.size}`;$('#capture').disabled=selected.size===0;}
async function persistScan(){if(lastScan)await chrome.storage.session.set({scanResult:{...lastScan,images,selectedIndices:images.flatMap((i,n)=>selected.has(i.id)?[n]:[])}});}
function renderJob(job){
 $('#duplicate-panel').hidden=job?.status!=='awaiting-duplicate';if(job?.status==='awaiting-duplicate')void renderDuplicate(job);
 currentJob=job;$('#job-panel').hidden=!job;if(!job)return;
 $('#job-heading').textContent=({'awaiting-duplicate':'等待处理重复图片',running:'正在后台采集',paused:'采集已暂停','waiting-service':'等待本地服务恢复',completed:'采集已完成',cancelled:'采集已取消'})[job.status]+` · ${job.index} / ${job.items.length}`;
 $('#job-current').textContent=job.index<job.items.length?'当前图片：'+(job.items[job.index].name||'网页图片')+' · 尚余 '+(job.items.length-job.index)+' 张未处理':'任务已处理完毕';
 $('#job-progress').value=job.index;$('#job-progress').max=job.items.length;
 $('#job-summary').textContent=`新增 ${job.added} · 重复 ${job.duplicates} · 失败 ${job.failures.length}${job.lastError?'。'+job.lastError.message:job.status==='running'?'。可关闭弹窗；暂停/取消在当前请求结束后生效。':''}${job.status==='waiting-service'?' 每 30 秒检查恢复。':''}`;
 const pending=['running','paused','waiting-service','awaiting-duplicate'].includes(job.status);$('#job-pause').hidden=!pending||job.status==='awaiting-duplicate';$('#job-pause').textContent=job.status==='paused'?(job.lastError?.code==='LIBRARY_CHANGED'?'保存到当前素材库并继续':'继续'):job.status==='waiting-service'?'暂停自动重连':'暂停';$('#job-cancel').hidden=!pending;$('#job-retry').hidden=!job.failures.length||pending;$('#job-errors').hidden=!job.failures.length;
 $('#job-errors').open=!!job.failures.length;
 $('#job-results').textContent=(job.results||[]).map(r=>`${r.status==='added'?'已保存':r.status==='duplicate'?'使用已有素材':'失败'}：${r.name}`).join('\n');
 $('#job-error-list').innerHTML=job.failures.map(f=>`<li>${esc(f.item.name||'网页图片')}：${esc(f.error)} <code>${esc(f.code||'CAPTURE_FAILED')}</code></li>`).join('');
}
async function renderDuplicate(job){
 const identity=job.id+':'+job.index;if(identity===duplicateIndex)return;duplicateIndex=identity;
 const m=job.duplicate.existing;$('#duplicate-existing').textContent=m.name;$('#duplicate-incoming').textContent=job.duplicate.incoming.name;$('#duplicate-info').textContent=[m.width&&m.height?m.width+' × '+m.height:'',Math.round(m.size/1024)+' KB','内容完全相同（SHA-256）'].filter(Boolean).join(' · ');
 for(const img of document.querySelectorAll('.duplicate-image'))img.removeAttribute('src');
 try{const src=await send({type:'duplicate-preview'});if(duplicateIndex===identity&&src)for(const img of document.querySelectorAll('.duplicate-image'))img.src=src;}catch{}
}
$('#duplicate-reuse').onclick=act(async()=>renderJob(await send({type:'job-control',action:'reuse'})));
$('#duplicate-keep').onclick=act(async()=>renderJob(await send({type:'job-control',action:'keep'})));
$('#view-library').onclick=act(async()=>{const c=await chrome.storage.local.get('server');await chrome.tabs.create({url:c.server||'http://127.0.0.1:41600'});});
$('#settings').onclick=()=>chrome.runtime.openOptionsPage();
$('#scan').onclick=act(async()=>{const button=$('#scan');button.disabled=true;$('#status').textContent='正在读取页面提供的图片候选…';try{const r=await send({type:'scan'});lastScan=r;images=r.images;selected.clear();tab={id:r.tabId,url:r.pageURL};render();$('#status').textContent=`找到 ${images.length} 张图片${r.truncated?'（已达扫描上限，结果不完整）':''}。滚动加载后可重新扫描。`;}finally{button.disabled=false;}});
$('#images').onclick=act(async e=>{const b=e.target.closest('[data-index]');if(!b)return;const i=images[Number(b.dataset.index)];selected.has(i.id)?selected.delete(i.id):selected.add(i.id);render();await persistScan();});
$('#images').onchange=act(async e=>{if(!e.target.matches('[data-candidate]'))return;images[Number(e.target.dataset.candidate)].chosenURL=e.target.value;await persistScan();});
$('#quality').onchange=act(async()=>{for(const i of images)delete i.chosenURL;render();await persistScan();});$('#min-size').onchange=act(async()=>{selected.clear();render();await persistScan();});
$('#select-all').onclick=act(async()=>{const list=images.filter(i=>Math.max(i.width,i.height)>=Number($('#min-size').value));if(list.every(i=>selected.has(i.id)))selected.clear();else selected=new Set(list.map(i=>i.id));render();await persistScan();});
$('#capture').onclick=act(async()=>{const items=images.filter(i=>selected.has(i.id)).map(i=>{const url=chosen(i);return {url,name:i.name,website:i.website,frameUrl:i.frameUrl,topPageURL:i.topPageURL,tabId:i.tabId,frameId:i.frameId,candidateSource:i.candidates?.find(c=>c.url===url)?.source||i.discovery,folderId:$('#folder').value,tags:tags()};});renderJob(await send({type:'enqueue',items}));selected.clear();render();await persistScan();$('#status').textContent='已提交；请查看上方任务进度和保存结果。';});
$('#job-pause').onclick=act(async()=>renderJob(await send({type:'job-control',action:currentJob.status==='paused'?'resume':'pause'})));$('#job-cancel').onclick=act(async()=>renderJob(await send({type:'job-control',action:'cancel'})));$('#job-retry').onclick=act(async()=>renderJob(await send({type:'job-retry'})));
$('#job-report').onclick=()=>{if(!currentJob)return;const report={...currentJob,items:currentJob.items.map(i=>({...i,url:i.url.startsWith('data:')?'[内嵌图片内容已省略]':i.url,thumbnail:i.thumbnail?'[网页预览已省略]':undefined})),failures:currentJob.failures.map(f=>({...f,item:{...f.item,url:f.item.url.startsWith('data:')?'[内嵌图片内容已省略]':f.item.url,thumbnail:undefined}}))};const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='assetnest-capture-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);};
$('#history').onclick=act(async()=>{const jobs=await send({type:'job-history'});$('#history-content').innerHTML=jobs.length?jobs.map(j=>`<p>${esc(new Date(j.updatedAt).toLocaleString())}<br>新增 ${j.added} · 重复 ${j.duplicates} · 失败 ${j.failed} · ${esc(j.status)}</p>`).join(''):'<p>暂无完成的任务</p>';$('#history-dialog').showModal();});$('#close-history').onclick=()=>$('#history-dialog').close();
async function shot({region=false,bookmark=false,withPreview=true}={}){const promise=send({type:'screenshot',tabId:tab?.id,region,bookmark,withPreview,folderId:$('#folder').value,tags:tags()});if(region)window.close();renderJob(await promise);$('#status').textContent='已加入后台队列。';}
$('#visible-shot').onclick=act(()=>shot());$('#region-shot').onclick=act(()=>shot({region:true}));$('#bookmark').onclick=act(()=>shot({bookmark:true}));$('#bookmark-only').onclick=act(()=>shot({bookmark:true,withPreview:false}));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.captureJob)renderJob(changes.captureJob.newValue);});
let destinationPath='';function showDestination(){$('#destination-info').textContent='保存到：'+destinationPath+' · '+($('#folder').selectedOptions[0]?.textContent||'未分类');}
$('#folder').onchange=()=>{void chrome.storage.local.set({folderId:$('#folder').value});showDestination();};$('#tags').onchange=()=>chrome.storage.local.set({tags:$('#tags').value});
async function init(){
 $('#status').textContent='正在连接本机素材库…';
 const c=await chrome.storage.local.get(['tags','folderId']);$('#tags').value=c.tags||'';
 const restore=await send({type:'scan-restore'});const active=(await chrome.tabs.query({active:true,currentWindow:true}))[0];if(restore&&active?.id===restore.tabId&&active.url===restore.pageURL){lastScan=restore;images=restore.images;tab=active;selected=new Set((restore.selectedIndices||[]).map(n=>images[n]?.id).filter(Boolean));render();}else if(active?.id)tab=active;
 renderJob(await send({type:'job-status'}));
 try{const r=await send({type:'connect'});$('#folder').innerHTML='<option value="">未分类</option>'+r.folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');$('#folder').value=c.folderId||'';destinationPath=r.library?.path||'当前素材库';showDestination();$('#status').textContent=`已连接本地素材库 · ${r.items.length} 个素材`;$('#connect-local').hidden=true;}catch(e){$('#status').textContent=e.message;$('#connect-local').hidden=false;}
}act(init)();
$('#connect-local').onclick=act(async()=>{const b=$('#connect-local');b.disabled=true;$('#status').textContent='正在自动连接…';try{await send({type:'auto-connect'});await init();}finally{b.disabled=false;}});
