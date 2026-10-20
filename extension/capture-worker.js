import {pageFeedback,jobFeedback} from './feedback.js';
import {CaptureQueue} from './queue.js';
import {scanPage} from './scanner.js';
import {readImageInPage,selectRegion} from './page-tools.js';
import {captureError,localError} from './capture-error.js';
import {autoConnect,localServer} from './auto-connect.js';

async function config(){
 const c=await chrome.storage.local.get(['server','key','folderId','tags','autoConnect']);c.server=(c.server||'http://127.0.0.1:41600').replace(/\/$/,'');
 let u;try{u=new URL(c.server);}catch{throw captureError('CONFIG_REQUIRED','服务地址无效，请检查插件设置',{pause:true});}
 if(!['127.0.0.1','localhost'].includes(u.hostname)||u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw captureError('CONFIG_REQUIRED','服务地址必须是本机 HTTP 地址',{pause:true});
 if(!c.key){if(c.autoConnect===false)throw captureError('AUTH_REQUIRED','自动连接已关闭，请在设置中连接素材库',{pause:true});Object.assign(c,await autoConnect(c.server));}return c;
}
async function api(route,c,options={}){
 let r;try{r=await fetch(c.server+'/api/'+route,{...options,headers:{'X-Assetnest-Key':c.key,...(c.libraryId?{'X-Assetnest-Library':c.libraryId}:{}),...options.headers},signal:AbortSignal.timeout(route==='capture'?60000:20000)});}catch(e){if(e.name==='TimeoutError')throw captureError('REQUEST_TIMEOUT','本地保存响应超时，任务已保留；恢复后先核对回执，避免重复保存',{retryable:true});throw captureError('SERVICE_UNAVAILABLE','无法连接本地素材库，任务已保留；请启动拾素材',{retryable:true});}
 let j;try{j=await r.json();}catch{throw captureError('SERVICE_UNAVAILABLE','本地服务响应异常，任务已保留',{retryable:true});}
 if(r.status===401&&c.autoConnect!==false&&!c.repaired){Object.assign(c,await autoConnect(c.server),{repaired:true});return api(route,c,options);}if(!r.ok)throw localError(r.status,j.error);return j;
}
async function ensureLocal(c){const j=await api('health',c);if(j.name!=='AssetNest')throw captureError('CONFIG_REQUIRED','服务地址不是拾素材，请检查端口',{pause:true});if(j.storageConfigured===false)throw captureError('CONFIG_REQUIRED','请先在拾素材中选择素材库保存位置',{pause:true});const [major,minor]=String(j.version).split('.').map(Number);if(!(major>=1||major===0&&minor>=4))throw captureError('SERVER_UPGRADE_REQUIRED','请先把拾素材本地服务升级到 0.4.0，再继续采集',{pause:true});return j;}
async function blobData(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return `data:${blob.type};base64,${btoa(binary)}`;}
async function imageData(url){
 if(!/^(https?:|data:image\/)/i.test(url))throw captureError('PAGE_REQUIRED','此图片必须从原页面读取');
 let r;try{r=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15000)});}catch{throw captureError('IMAGE_NETWORK','浏览器下载图片失败，可能是网络或请求来源限制');}
 if(!r.ok)throw captureError('IMAGE_HTTP_'+r.status,'图片服务器返回 HTTP '+r.status);
 const type=(r.headers.get('content-type')||'').split(';')[0];if(!type.startsWith('image/'))throw captureError('NOT_IMAGE','图片地址返回的内容不是图片');
 if(Number(r.headers.get('content-length'))>32*1024*1024)throw captureError('IMAGE_TOO_LARGE','单张图片超过插件 32MB 限制');
 let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>32*1024*1024)throw captureError('IMAGE_TOO_LARGE','单张图片超过插件 32MB 限制');chunks.push(chunk);}
 const blob=new Blob(chunks,{type});let dimensions={};try{const bitmap=await createImageBitmap(blob);dimensions={width:bitmap.width,height:bitmap.height};bitmap.close();}catch{}
 return {base64:await blobData(blob),transport:url.startsWith('data:')?'inline':'browser',...dimensions};
}
async function inOriginalPage(item){
 if(!Number.isInteger(item.tabId))throw captureError('SOURCE_PAGE_GONE','原页面不可用，Blob 或登录态图片需要保持原页面打开');
 let tab;try{tab=await chrome.tabs.get(item.tabId);}catch{throw captureError('SOURCE_PAGE_GONE','原页面已关闭，请回到原页面重新扫描');}
 if(item.topPageURL&&tab.url!==item.topPageURL)throw captureError('SOURCE_PAGE_CHANGED','原标签页已导航到其他地址，请重新扫描');
 let results;try{results=await chrome.scripting.executeScript({target:{tabId:item.tabId,frameIds:[item.frameId||0]},func:readImageInPage,args:[item.url,8*1024*1024,item.frameUrl||null]});}catch{throw captureError('SOURCE_PAGE_GONE','无法访问原页面，页面可能已关闭或不允许读取');}
 const r=results[0]?.result;if(!r?.ok)throw captureError(r?.code||'PAGE_IMAGE_UNAVAILABLE',r?.error||'页面图片无法读取');return {...r,transport:'page'};
}
async function capture(item,context={}){
 const c=await config(),health=await ensureLocal(c);c.libraryId=health.libraryId;
 if(context.target&&(context.target.server!==c.server||context.target.libraryId!==health.libraryId))throw captureError('LIBRARY_CHANGED','目标素材库已切换，请取消原任务后重新提交',{pause:true});
 if(context.jobId&&!context.target&&health.libraryId)await queue.mutate(async()=>{const current=await queue.read();if(current?.id===context.jobId&&!current.target){current.target={server:c.server,libraryId:health.libraryId};await queue.save(current);}});
 if(context.key){const receipt=await api('capture-receipt?key='+encodeURIComponent(context.key),c);if(receipt.found)return {...receipt.result,transport:'receipt'};}
 if(item.kind==='bookmark')return {...await api('bookmark',c,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.website||item.url,name:item.name,tags:item.tags,folderId:item.folderId,thumbnail:item.thumbnail||null,duplicateMode:item.duplicateMode||'ask',idempotencyKey:context.key})}),transport:'bookmark'};
 let data,downloadError;
 if(item.url.startsWith('blob:'))data=await inOriginalPage(item);
 else {try{data=await imageData(item.url);}catch(e){downloadError=e;if(e.code==='IMAGE_TOO_LARGE')throw e;try{data=await inOriginalPage(item);}catch(pageError){if(!/^https?:/.test(item.url))throw pageError;}}}
 const payload={duplicateMode:item.duplicateMode||'ask',url:item.url,name:item.name,website:item.website,tags:item.tags??(c.tags||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean),folderId:item.folderId??c.folderId,captureKind:item.captureKind||'image',frameUrl:item.frameUrl,candidateSource:item.candidateSource,acquisition:data?.transport||'local-download',idempotencyKey:context.key,...data};
 try{return {...await api('capture',c,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),transport:payload.acquisition};}
 catch(e){if(downloadError&&e.code==='LOCAL_REJECTED')throw captureError(downloadError.code,downloadError.message+'；页面读取及本地下载也未成功');throw e;}
}
let feedbackStamp='';
async function openResults(){const url=chrome.runtime.getURL('popup.html')+'?results=1';const existing=(await chrome.tabs.query({})).find(t=>t.url===url);if(existing){await chrome.tabs.update(existing.id,{active:true});if(Number.isInteger(existing.windowId))await chrome.windows.update(existing.windowId,{focused:true});}else await chrome.tabs.create({url});}
async function publishStatus(job){try{const c=await chrome.storage.local.get(['server','key']);if(!c.key)return;await fetch((c.server||'http://127.0.0.1:41600')+'/api/collector-status',{method:'POST',headers:{'Content-Type':'application/json','X-Assetnest-Key':c.key},signal:AbortSignal.timeout(1500),body:JSON.stringify({id:job.id,status:job.status,index:job.index,total:job.items.length,error:job.lastError?.message||job.failures.at(-1)?.error||'',targetLibraryId:job.target?.libraryId||null,previousJobId:job.previousJobId||null})});}catch{}}
async function reportSubmitError(e,items=[]){await notify({title:'采集未提交',detail:e.message,persistent:true},items);if(e.code==='QUEUE_BUSY'){const job=await queue.read();if(job)await publishStatus(job);await openResults();}}

async function notify(message,items=[]){
 await chrome.storage.local.set({lastStatus:message.title+'：'+message.detail});
 const ids=[...new Set(items.map(i=>i.tabId).filter(Number.isInteger))];
 if(!ids.length){const tab=(await chrome.tabs.query({active:true,currentWindow:true}))[0];if(tab?.id)ids.push(tab.id);}
 for(const tabId of ids)try{await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:pageFeedback,args:[message]});}catch{}
 await chrome.action.setTitle({title:'拾素材 · '+message.title+' · '+message.detail});
}
async function badge(text,color){await chrome.action.setBadgeText({text});await chrome.action.setBadgeBackgroundColor({color});}
async function activeTab(tabId){const tab=tabId?await chrome.tabs.get(tabId):(await chrome.tabs.query({active:true,currentWindow:true}))[0];if(!tab?.id||!/^https?:/i.test(tab.url||''))throw captureError('UNSUPPORTED_PAGE','此页面不支持采集，请打开普通网页');return tab;}
async function scan(tabId){
 const tab=await activeTab(tabId);let frames;
 try{frames=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:scanPage});}catch{throw captureError('SCAN_DENIED','当前页面不允许扫描，请检查插件站点权限');}
 const found=new Map(),warnings=[];let truncated=false;
 for(const frame of frames){const r=frame.result;if(!r)continue;warnings.push(...(r.warnings||[]));truncated||=r.truncated;for(const i of r.images||[]){if(found.has(i.id))continue;if(found.size>=1000){truncated=true;break;}found.set(i.id,{...i,tabId:tab.id,frameId:frame.frameId,topPageURL:tab.url,website:tab.url});}}
 let images=[...found.values()];while(JSON.stringify(images).length>4*1024*1024){images.pop();truncated=true;}
 const result={images,title:tab.title,tabId:tab.id,pageURL:tab.url,truncated,warnings:[...new Set(warnings)],createdAt:Date.now()};await chrome.storage.session.set({scanResult:result});return result;
}
let screenshotTail=Promise.resolve(),lastScreenshotAt=0;
function captureScreenshot(windowId,tabId,pageURL){
 const result=screenshotTail.then(async()=>{await new Promise(r=>setTimeout(r,Math.max(0,650-(Date.now()-lastScreenshotAt))));const active=(await chrome.tabs.query({windowId,active:true}))[0];if(active?.id!==tabId||active.url!==pageURL)throw captureError('SOURCE_PAGE_CHANGED','截图前页面已切换，请重试');lastScreenshotAt=Date.now();return chrome.tabs.captureVisibleTab(windowId,{format:'jpeg',quality:90});});
 screenshotTail=result.catch(()=>{});return result;
}
async function screenshotItem(tabId,region=false,bookmark=false){
 const tab=await activeTab(tabId);if(!tab.active)throw captureError('TAB_NOT_ACTIVE','请切回要截图的网页再操作');
 let rect=null;if(region){const r=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:selectRegion});rect=r[0]?.result;if(!rect||rect.cancelled)throw captureError('USER_CANCELLED','已取消区域截图');}
 const current=await chrome.tabs.get(tab.id);if(!current.active||current.url!==tab.url)throw captureError('SOURCE_PAGE_CHANGED','截图前页面已切换，请重试');
 let dataURL;try{dataURL=await captureScreenshot(tab.windowId,tab.id,tab.url);}catch(e){if(e.code)throw e;if(/MAX_CAPTURE|quota|too many/i.test(e.message))throw captureError('SCREENSHOT_RATE_LIMIT','截图过于频繁，请稍后重试');throw captureError('SCREENSHOT_DENIED','浏览器未授予当前页截图权限，请在网页上点击插件图标或右键截图菜单重试');}
 const bitmap=await createImageBitmap(await(await fetch(dataURL)).blob());let width=bitmap.width,height=bitmap.height,sx=0,sy=0,sw=width,sh=height;
 if(rect){sx=Math.round(rect.x*width/rect.viewportWidth);sy=Math.round(rect.y*height/rect.viewportHeight);sw=Math.round(rect.width*width/rect.viewportWidth);sh=Math.round(rect.height*height/rect.viewportHeight);width=sw;height=sh;}
 if(bookmark){const scale=Math.min(1,720/width);width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));}
 const canvas=new OffscreenCanvas(width,height);canvas.getContext('2d').drawImage(bitmap,sx,sy,sw,sh,0,0,width,height);bitmap.close();
 const base64=await blobData(await canvas.convertToBlob({type:bookmark?'image/png':'image/jpeg',quality:.9}));if(base64.length>1024*1024)throw captureError('IMAGE_TOO_LARGE','截图超过 1MB，请选择较小区域或缩小窗口');
 const c=await config(),common={website:tab.url,name:(bookmark?'网页收藏 - ':region?'区域截图 - ':'截图 - ')+(tab.title||'网页'),tags:(c.tags||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean),folderId:c.folderId};
 return bookmark?{...common,kind:'bookmark',url:tab.url,thumbnail:base64}:{...common,url:base64,captureKind:region?'region-screenshot':'visible-screenshot'};
}
const queue=new CaptureQueue({
 read:async()=>(await chrome.storage.local.get('captureJob')).captureJob,
 write:job=>chrome.storage.local.set({captureJob:job}),capture,
 onChange:async job=>{
  await publishStatus(job);
  if(['awaiting-duplicate','paused'].includes(job.status)&&feedbackStamp!==job.id+':'+job.status)await openResults();
  const stamp=job.id+':'+job.status;if(stamp!==feedbackStamp){feedbackStamp=stamp;const message=jobFeedback(job),id=job.duplicate?.existing?.id||job.results?.findLast(r=>r.itemId)?.itemId;
  if(id&&['completed','awaiting-duplicate'].includes(job.status))try{const c=await chrome.storage.local.get(['server','key']);const r=await fetch((c.server||'http://127.0.0.1:41600')+'/media/'+id+'/thumb',{headers:{'X-Assetnest-Key':c.key,'X-Assetnest-Library':job.target?.libraryId||''},signal:AbortSignal.timeout(4000)});if(r.ok&&Number(r.headers.get('content-length')||Infinity)<524288){const b=await r.blob();if(b.size<524288)message.thumbnail=await blobData(b);}}catch{}
  await notify(message,job.items);}
  if(['running','waiting-service'].includes(job.status)){await chrome.alarms.create('assetnest-queue',{periodInMinutes:.5});await badge(job.status==='waiting-service'?'…':String(job.items.length-job.index),'#6570df');}
  else {if(job.status==='paused'&&job.lastError?.code==='LIBRARY_CHANGED')await chrome.alarms.create('assetnest-queue',{periodInMinutes:.5});else await chrome.alarms.clear('assetnest-queue');await badge(job.status==='awaiting-duplicate'?'?':job.status==='paused'?'Ⅱ':job.failures.length?'!':job.status==='completed'?'✓':'',job.failures.length?'#cf6262':'#369875');}
  if(['completed','cancelled'].includes(job.status)){const history=(await chrome.storage.local.get('jobHistory')).jobHistory||[];const summary={lastError:job.lastError||null,results:job.results||[],id:job.id,status:job.status,total:job.items.length,processed:job.index,added:job.added,duplicates:job.duplicates,failed:job.failures.length,updatedAt:job.updatedAt};await chrome.storage.local.set({jobHistory:[summary,...history.filter(j=>j.id!==job.id)].slice(0,20)});}
 }
});
async function enqueue(items){const c=await config();if(!Array.isArray(items))throw captureError('INVALID_REQUEST','采集项目需要为数组');let target=null;try{const health=await ensureLocal(c);target={server:c.server,libraryId:health.libraryId};await chrome.storage.local.set({connectedLibrary:target});}catch(e){if(!e.retryable)throw e;}return queue.enqueue(items.map(item=>({...item,tags:item.tags??(c.tags||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean),folderId:item.folderId??c.folderId})),{target});}
function drain(){void queue.run().catch(async e=>{await chrome.storage.local.set({lastStatus:'后台采集异常：'+e.message});await badge('!','#cf6262');await notify({title:'后台采集异常',detail:e.message,persistent:true});});}
async function rebindPending(job){const c=await config(),health=await ensureLocal(c);c.libraryId=health.libraryId;const data=await api('items',c);const target={server:c.server,libraryId:health.libraryId};const updated=await queue.retarget(job.id,target,data.folders.map(f=>f.id));await chrome.storage.local.set({connectedLibrary:target});drain();return updated;}
async function resumePending(){
 const previous=await queue.read();if(previous?.status==='paused'&&previous.lastError?.code==='LIBRARY_CHANGED')try{const c=await config(),state=await api('collector-status',c);if(state.recovery?.jobId===previous.id&&state.recovery.libraryId===state.libraryId&&!state.recovery.resolved){await rebindPending(previous);return;}}catch{}

 const job=await queue.read();if(job&&['running','waiting-service'].includes(job.status))await chrome.alarms.create('assetnest-queue',{periodInMinutes:.5});if(job?.status==='waiting-service'){try{await ensureLocal(await config());await queue.control('resume');}catch(e){if(e.pause)await queue.mutate(async()=>{const latest=await queue.read();if(latest?.id===job.id&&latest.status==='waiting-service')await queue.save({...latest,status:'paused',lastError:{code:e.code,message:e.message,index:latest.index,pause:true},updatedAt:Date.now()});});return;}}
 const latest=await queue.read();if(latest?.status==='running'){await chrome.alarms.create('assetnest-queue',{periodInMinutes:.5});drain();}
}
chrome.runtime.onInstalled.addListener(()=>{chrome.contextMenus.removeAll(()=>{for(const menu of [{id:'assetnest-save',title:'保存图片到拾素材',contexts:['image']},{id:'assetnest-bookmark',title:'收藏网页到拾素材（含画面）',contexts:['page']},{id:'assetnest-visible',title:'保存当前画面到拾素材',contexts:['page']},{id:'assetnest-region',title:'选择区域截图到拾素材',contexts:['page']}])chrome.contextMenus.create(menu);});void resumePending();});
chrome.runtime.onStartup.addListener(()=>{void resumePending();});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='assetnest-queue')void resumePending();});
chrome.contextMenus.onClicked.addListener(async(info,tab)=>{
 try{if(!info.menuItemId.startsWith('assetnest-'))return;let item;if(info.menuItemId==='assetnest-save')item={url:info.srcUrl,website:info.pageUrl||tab.url,frameUrl:info.frameUrl||tab.url,topPageURL:tab.url,tabId:tab.id,frameId:info.frameId||0,name:tab.title||'网页图片'};else item=await screenshotItem(tab.id,info.menuItemId==='assetnest-region',info.menuItemId==='assetnest-bookmark');await enqueue([item]);drain();await chrome.storage.local.set({lastStatus:'已加入后台采集队列'});}catch(e){await reportSubmitError(e,[{tabId:tab?.id}]);await badge('!','#cf6262');}
});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return;
 const run=async()=>{
   if(m.type==='open-results'){await openResults();return true;}
   if(m.type==='duplicate-preview'){const job=await queue.read();if(!job?.duplicate)throw Error('没有待处理的重复图片');const c=await config();c.libraryId=job.target?.libraryId;const r=await fetch(c.server+'/media/'+job.duplicate.existing.id+'/thumb',{headers:{'X-Assetnest-Key':c.key,'X-Assetnest-Library':c.libraryId},signal:AbortSignal.timeout(10000)});if(!r.ok)return null;return blobData(await r.blob());}
   if(m.type==='auto-connect'){const saved=await chrome.storage.local.get('server');await autoConnect(m.server||saved.server||'http://127.0.0.1:41600');return {connected:true};}
   if(m.type==='capture')return capture(m.item);
  if(m.type==='connect'){const c=await config(),items=await api('items',c),health=await ensureLocal(c);await chrome.storage.local.set({connectedLibrary:{server:c.server,libraryId:health.libraryId}});return {...items,library:items.library||{id:health.libraryId,path:null}};}
  if(m.type==='scan')return scan(m.tabId);
  if(m.type==='scan-restore')return (await chrome.storage.session.get('scanResult')).scanResult||null;
  if(m.type==='screenshot'){let item;if(m.bookmark&&m.withPreview===false){const tab=await activeTab(m.tabId);item={kind:'bookmark',url:tab.url,website:tab.url,name:tab.title||'网页收藏'};}else item=await screenshotItem(m.tabId,m.region,m.bookmark);if(m.tags)item.tags=m.tags;if(m.folderId!==undefined)item.folderId=m.folderId;const job=await enqueue([item]);drain();return job;}
  if(m.type==='enqueue'){const job=await enqueue(m.items);drain();return job;}
  if(m.type==='job-recover'){await resumePending();return (await queue.read())||null;}
  if(m.type==='job-status'){void resumePending().catch(()=>{});return (await queue.read())||null;}
  if(m.type==='job-control'){const previous=await queue.read();if(m.action==='resume'&&previous?.lastError?.code==='LIBRARY_CHANGED')return rebindPending(previous);const job=await queue.control(m.action);if(job.status==='running')drain();return job;}
  if(m.type==='job-retry'){const job=await queue.retry();drain();return job;}
  if(m.type==='job-history')return (await chrome.storage.local.get('jobHistory')).jobHistory||[];
  throw captureError('UNKNOWN_REQUEST','未知请求');
 };
 run().then(data=>reply({ok:true,data})).catch(async e=>{reply({ok:false,error:e.message,code:e.code||'CAPTURE_FAILED'});if(['enqueue','screenshot','job-retry'].includes(m.type))await reportSubmitError(e,m.items||[]);});return true;
});

void resumePending().catch(()=>{});
