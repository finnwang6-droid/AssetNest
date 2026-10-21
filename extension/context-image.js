// Self-contained, serialized into the frame where the context menu was opened.
export function resolveContextImage({srcUrl=null,linkUrl=null,frameURL=null}={}){
 if(frameURL&&location.href!==frameURL)return {ok:false,error:'原页面已跳转，请重新右键选择图片'};
 const safe=value=>{if(typeof value!=='string'||!value.trim())return null;try{const u=new URL(value,document.baseURI);return /^(https?:|blob:|data:image\/)/i.test(u.href)?u.href:null;}catch{return null;}};
 if(srcUrl&&safe(srcUrl))return {ok:true,url:safe(srcUrl)};
 const point=globalThis.__assetnestContextTarget;
 if(!point||point.pageURL!==location.href||Date.now()-point.at>60000)return {ok:false,error:'请刷新网页后，重新在图片上右键采集'};
 const hit=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&point.x>=r.left&&point.x<=r.right&&point.y>=r.top&&point.y<=r.bottom;};
 const stack=document.elementsFromPoint(point.x,point.y),images=[];
 const add=el=>{if(el?.tagName==='IMG'&&hit(el)&&!images.includes(el))images.push(el);};
 for(const el of stack)add(el);
 // Overlay links often sit beside the image. Bound the search to nearby parents
 // and require the image itself to cover the click, never a neighbouring card.
 for(const el of stack.slice(0,5)){let parent=el;for(let depth=0;parent&&depth<3;depth++,parent=parent.parentElement){if(['BODY','HTML'].includes(parent.tagName))break;const found=parent.querySelectorAll('img');if(found.length>20)continue;for(const img of found)add(img);}}
 const image=images.find(img=>safe(img.currentSrc||img.src));if(image)return {ok:true,url:safe(image.currentSrc||image.src),name:image.alt||image.title||null};
 for(const el of stack){if(['BODY','HTML'].includes(el.tagName)||!hit(el))continue;const r=el.getBoundingClientRect();if(r.width*r.height>innerWidth*innerHeight*.9)continue;const bg=getComputedStyle(el).backgroundImage||'';for(const m of bg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)){const url=safe((m[1]??m[2]??m[3]).trim());if(url)return {ok:true,url,name:el.getAttribute('aria-label')||null};}}
 if(linkUrl&&/\.(png|jpe?g|webp|gif|avif|svg|bmp|tiff?)(?:[?#]|$)/i.test(linkUrl)&&safe(linkUrl))return {ok:true,url:safe(linkUrl)};
 return {ok:false,error:'此处没有可识别的图片，请在图片中间右键，或使用页面扫描／区域截图'};
}
export const captureMenus=[
 {id:'assetnest-save',title:'保存此处图片到拾素材',contexts:['image','link','page']},
 {id:'assetnest-bookmark',title:'收藏网页到拾素材（含画面）',contexts:['page']},
 {id:'assetnest-visible',title:'保存当前画面到拾素材',contexts:['page']},
 {id:'assetnest-region',title:'选择区域截图到拾素材',contexts:['page']}
];
