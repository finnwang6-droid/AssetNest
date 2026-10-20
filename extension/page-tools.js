// This function is injected into the original frame, including for frame-owned Blob URLs.
export async function readImageInPage(url,maxBytes=8*1024*1024,expectedFrameURL=null){
 try{
  if(expectedFrameURL&&location.href!==expectedFrameURL)return {ok:false,code:'SOURCE_PAGE_CHANGED',error:'原框架已导航到其他地址，请重新扫描'};
  if(!/^(https?:|blob:|data:image\/)/i.test(url))return {ok:false,code:'UNSUPPORTED_URL',error:'不支持此图片地址'};
  const response=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15000)});
  if(!response.ok)return {ok:false,code:'IMAGE_HTTP_'+response.status,error:'页面下载返回 HTTP '+response.status};
  const type=(response.headers.get('content-type')||'').split(';')[0];if(!type.startsWith('image/'))return {ok:false,code:'NOT_IMAGE',error:'页面返回内容不是图片'};
  if(Number(response.headers.get('content-length'))>maxBytes)return {ok:false,code:'IMAGE_TOO_LARGE',error:'页面内图片超过 8MB，请改用直接图片地址'};
  let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)return {ok:false,code:'IMAGE_TOO_LARGE',error:'页面内图片超过 8MB'};chunks.push(chunk);}
  const blob=new Blob(chunks,{type});const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});return {ok:true,base64};
 }catch(e){return {ok:false,code:'PAGE_IMAGE_UNAVAILABLE',error:'页面内读取失败，可能受跨域、登录状态或页面已关闭影响：'+e.message};}
}

export function selectRegion(){
 return new Promise(resolve=>{
  if(document.getElementById('__assetnest_region'))return resolve({cancelled:true});
  const overlay=document.createElement('div');overlay.id='__assetnest_region';overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(30,35,60,.15);';
  const box=document.createElement('div');box.style.cssText='position:absolute;border:2px solid #737cf1;background:rgba(100,110,240,.12);pointer-events:none;';
  const tip=document.createElement('div');tip.textContent='拖动选择截图区域 · Esc 取消';tip.style.cssText='position:absolute;top:15px;left:50%;transform:translateX(-50%);padding:10px 15px;background:#30364d;color:white;border-radius:8px;font:13px sans-serif;pointer-events:none;';overlay.append(box,tip);document.documentElement.append(overlay);
  let start=null;const timer=setTimeout(()=>finish({cancelled:true}),60000);
  function finish(result){clearTimeout(timer);overlay.remove();document.removeEventListener('keydown',key,true);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(result)));}
  function key(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish({cancelled:true});}}
  document.addEventListener('keydown',key,true);
  overlay.onpointerdown=e=>{e.preventDefault();start={x:e.clientX,y:e.clientY};overlay.setPointerCapture(e.pointerId);};
  overlay.onpointermove=e=>{if(!start)return;const x=Math.min(start.x,e.clientX),y=Math.min(start.y,e.clientY);box.style.left=x+'px';box.style.top=y+'px';box.style.width=Math.abs(e.clientX-start.x)+'px';box.style.height=Math.abs(e.clientY-start.y)+'px';};
  overlay.onpointerup=e=>{if(!start)return;const x=Math.max(0,Math.min(start.x,e.clientX)),y=Math.max(0,Math.min(start.y,e.clientY));const width=Math.min(innerWidth-x,Math.abs(e.clientX-start.x)),height=Math.min(innerHeight-y,Math.abs(e.clientY-start.y));finish(width<3||height<3?{cancelled:true}:{x,y,width,height,viewportWidth:innerWidth,viewportHeight:innerHeight});};
 });
}
