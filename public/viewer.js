const $=s=>document.querySelector(s);
let generation=0,dispose=()=>{},regionClean=()=>{};
export function closeViewer(){generation++;dispose();dispose=()=>{};regionClean();regionClean=()=>{};}
export async function openViewer(item,{saveRegions,onError}){
 closeViewer();const token=generation,img=$('#detail-image'),preview=$('.preview');
 let area=$('#asset-viewer');if(!area){area=document.createElement('div');area.id='asset-viewer';preview.append(area);}area.replaceChildren();area.hidden=true;img.hidden=false;$('.zoom-tools').hidden=false;
 const ext=item.ext.toLowerCase(),url='/media/'+encodeURIComponent(item.id)+'/original';
 const original=$('#original-link');if(ext!=='url'){original.href=url+'?download=1';original.textContent='下载原文件 ↗';}
 const image=['jpg','jpeg','png','gif','webp','avif','svg','bmp','tif','tiff','psd','url'].includes(ext);
 if(image){if(['tif','tiff','psd'].includes(ext))img.src='/media/'+item.id+'/preview';const failed=()=>{if(token!==generation)return;img.hidden=true;$('.zoom-tools').hidden=true;area.hidden=false;const note=document.createElement('p');note.className='viewer-note';note.textContent=ext==='psd'?'PSD 预览生成失败：文件可能损坏、超出预览限制，或没有保存兼容合成图。请用 Photoshop 打开并启用最大兼容性后重新保存。':'无法读取图片预览，请使用默认程序打开原文件。';area.replaceChildren(note);};img.addEventListener('error',failed);const clean=regions(item,img,saveRegions,onError);regionClean=()=>{img.removeEventListener('error',failed);clean();};return;}
 img.hidden=true;$('.zoom-tools').hidden=true;area.hidden=false;
 const note=document.createElement('p');note.className='viewer-note';area.append(note);
 try{
  if(['mp4','webm','ogv','mov','mp3','wav','ogg','oga','m4a','aac','flac','opus'].includes(ext)){
   const video=['mp4','webm','ogv','mov'].includes(ext),media=document.createElement(video?'video':'audio');media.id='asset-media';media.controls=true;media.preload='metadata';media.src=url;if(video){media.muted=media.defaultMuted=true;media.playsInline=true;media.loop=true;media.onpointerenter=()=>void media.play().catch(()=>{});media.onpointerleave=()=>media.pause();}area.prepend(media);note.textContent=video?'悬停静音播放，移开暂停；可拖动进度。':'使用浏览器支持的编码播放；可拖动进度、调节音量。';media.onerror=()=>note.textContent='浏览器无法播放此编码，请下载原文件，用本地播放器打开。';dispose=()=>{media.onpointerenter=media.onpointerleave=null;media.pause();media.removeAttribute('src');media.load();};return;
  }
  if(ext==='pdf'){
   note.textContent='正在读取 PDF…';const pdfjs=await import('/vendor/pdf.mjs');if(token!==generation)return;pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
   const task=pdfjs.getDocument({url,isEvalSupported:false,useSystemFonts:true,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/'});let document=null,render=null;dispose=()=>{render?.cancel();task.destroy();};document=await task.promise;if(token!==generation)return;
   const controls=window.document.createElement('div');controls.className='viewer-controls';const prev=window.document.createElement('button'),next=window.document.createElement('button'),status=window.document.createElement('span'),canvas=window.document.createElement('canvas');prev.textContent='上一页';next.textContent='下一页';canvas.id='pdf-canvas';controls.append(prev,status,next);area.prepend(controls,canvas);let page=1,busy=false;
   async function show(n){if(busy||token!==generation)return;busy=true;page=n;prev.disabled=next.disabled=true;try{const p=await document.getPage(page);if(token!==generation)return;const first=p.getViewport({scale:1}),scale=Math.min(2,Math.max(200,area.clientWidth-40)/first.width),view=p.getViewport({scale});canvas.width=view.width;canvas.height=view.height;render=p.render({canvasContext:canvas.getContext('2d'),viewport:view});await render.promise;status.textContent=`${page} / ${document.numPages}`;note.textContent='PDF 页面预览';}catch(e){if(token===generation)note.textContent='PDF 页面读取失败：'+e.message;}finally{busy=false;prev.disabled=page<=1;next.disabled=page>=document.numPages;}}
   prev.onclick=()=>show(page-1);next.onclick=()=>show(page+1);await show(1);return;
  }
  if(['ttf','otf','woff','woff2'].includes(ext)){
   const family='AssetNestPreview'+token,face=new FontFace(family,`url("${url}")`);note.textContent='正在载入字体…';await face.load();if(token!==generation)return;document.fonts.add(face);dispose=()=>document.fonts.delete(face);
   const text=document.createElement('textarea');text.id='font-specimen';text.value='拾素材 · 字体预览\nThe quick brown fox jumps over the lazy dog\nABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz 0123456789';text.style.fontFamily='"'+family+'"';const size=document.createElement('input');size.type='range';size.min=12;size.max=120;size.value=36;size.setAttribute('aria-label','字号');size.oninput=()=>text.style.fontSize=size.value+'px';text.style.fontSize='36px';area.prepend(size,text);note.textContent='可编辑预览文字，拖动滑块调整字号。缺失字形由系统字体补齐。';return;
  }
  note.textContent=`${ext.toUpperCase()} 原文件已保存，暂不支持内部预览。`;
  const link=document.createElement('a');link.href=url+'?download=1';link.textContent='下载原文件';area.append(link);
 }catch(e){if(token===generation)note.textContent='预览失败：'+e.message+'。可下载原文件查看。';}
}
function regions(item,img,save,onError){
 if(item.ext.toLowerCase()==='url')return ()=>{};
 const toolbar=document.createElement('div');toolbar.className='region-toolbar';toolbar.hidden=true;const toggle=document.createElement('button'),list=document.createElement('select'),text=document.createElement('input'),commit=document.createElement('button'),remove=document.createElement('button');toggle.textContent='框选注释';toggle.type=commit.type=remove.type='button';text.placeholder='区域注释文字';text.maxLength=4000;commit.textContent='保存区域';remove.textContent='删除区域';toolbar.append(toggle,list,text,commit,remove);$('.preview').append(toolbar);
 const layer=document.createElement('div');layer.className='region-layer';$('.preview').append(layer);let entries=structuredClone(item.assetnestRegions||[]),draft=null,enabled=false,start=null;
 const select=()=>{draft=entries[Number(list.value)]?{...entries[Number(list.value)]}:null;text.value=draft?.text||'';draw();};
 function options(){list.replaceChildren();const empty=document.createElement('option');empty.value='-1';empty.textContent='新区域';list.append(empty);entries.forEach((r,n)=>{const o=document.createElement('option');o.value=n;o.textContent=(n+1)+'. '+(r.text||'未命名区域');list.append(o);});list.value='-1';}
 function rect(){const a=img.getBoundingClientRect(),p=$('.preview').getBoundingClientRect();return {a,p};}
 function draw(){layer.replaceChildren();const {a,p}=rect();for(const r of [...entries,...(draft?[draft]:[])]){const box=document.createElement('div');box.className='region-box';box.style.cssText=`left:${a.left-p.left+r.x*a.width}px;top:${a.top-p.top+r.y*a.height}px;width:${r.width*a.width}px;height:${r.height*a.height}px`;box.title=r.text;layer.append(box);}}
 function point(e){const {a}=rect();return {x:Math.max(0,Math.min(1,(e.clientX-a.left)/a.width)),y:Math.max(0,Math.min(1,(e.clientY-a.top)/a.height))};}
 function down(e){if(!enabled||e.target!==img)return;e.stopImmediatePropagation();e.preventDefault();start=point(e);draft=null;list.value='-1';img.setPointerCapture(e.pointerId);}
 function move(e){if(!start)return;const p=point(e);draft={x:Math.min(p.x,start.x),y:Math.min(p.y,start.y),width:Math.abs(p.x-start.x),height:Math.abs(p.y-start.y),text:text.value};draw();e.stopImmediatePropagation();}
 function up(e){if(!start)return;start=null;e.stopImmediatePropagation();if(draft&&(draft.width<.005||draft.height<.005))draft=null;draw();}
 toggle.onclick=()=>{enabled=!enabled;toggle.classList.toggle('active',enabled);toggle.textContent=enabled?'结束框选':'框选注释';img.style.cursor=enabled?'crosshair':'';};list.onchange=select;
 async function persist(next){commit.disabled=remove.disabled=true;try{await save(item.id,next);entries=next;draft=null;options();draw();}catch(e){onError(e.message);}finally{commit.disabled=remove.disabled=false;}}
 commit.onclick=()=>{if(!draft)return onError('请先在图片上框选一个区域');const next=structuredClone(entries),r={...draft,text:text.value};if(Number(list.value)>=0)next[Number(list.value)]=r;else next.push(r);void persist(next);};remove.onclick=()=>{if(Number(list.value)<0)return;void persist(entries.filter((_,n)=>n!==Number(list.value)));};
 img.addEventListener('pointerdown',down,true);$('.preview').addEventListener('pointermove',move,true);$('.preview').addEventListener('pointerup',up,true);const observer=new MutationObserver(draw);observer.observe(img,{attributes:true,attributeFilter:['style']});const resize=new ResizeObserver(draw);resize.observe(img);img.addEventListener('load',draw);options();draw();
 return ()=>{toolbar.remove();layer.remove();observer.disconnect();resize.disconnect();img.style.cursor='';img.removeEventListener('load',draw);img.removeEventListener('pointerdown',down,true);$('.preview').removeEventListener('pointermove',move,true);$('.preview').removeEventListener('pointerup',up,true);};
}
