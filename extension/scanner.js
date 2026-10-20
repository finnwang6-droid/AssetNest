// Self-contained: Chrome serializes this function into the selected page.
export function scanPage(options={}) {
  const maxElements=options.maxElements||15000,maxImages=options.maxImages||1000;
  const groups=new Map(),warnings=[];let truncated=false,scannedElements=0;
  function absolute(value){try{const u=new URL(value,document.baseURI);return /^(https?:|blob:|data:image\/)/i.test(u.href)?u.href:null;}catch{return null;}}
  function srcset(value){
    const results=[];let i=0;
    while(i<value.length){while(/[\s,]/.test(value[i]||'')&&i<value.length)i++;if(i>=value.length)break;let url='';while(i<value.length&&!/\s/.test(value[i]))url+=value[i++];if(url.endsWith(',')){results.push({url:url.replace(/,+$/,''),width:0,density:1});continue;}let descriptor='';while(i<value.length&&value[i]!==',')descriptor+=value[i++];i++;const d=descriptor.trim();results.push({url,width:/^\d+w$/.test(d)?Number(d.slice(0,-1)):0,density:/^\d*\.?\d+x$/.test(d)?Number(d.slice(0,-1)):1});}
    return results;
  }
  function collect(candidates,info){
    const unique=new Map();for(const c of candidates){const url=absolute(c.url);if(!url||url.length>512*1024)continue;const entry={...c,url,width:c.width||0};const old=unique.get(url);if(!old||(entry.priority||0)>(old.priority||0)||entry.width>old.width)unique.set(url,entry);}
    const list=[...unique.values()].sort((a,b)=>(b.priority||0)-(a.priority||0)||b.width-a.width||(b.density||1)-(a.density||1));if(!list.length)return;
    const current=list.find(c=>c.url===absolute(info.current))||list[list.length-1],best=list[0];
    const key=best.url;const existing=groups.get(key);
    if(existing){const seen=new Set(existing.candidates.map(c=>c.url));for(const c of list)if(!seen.has(c.url))existing.candidates.push(c);existing.width=Math.max(existing.width,info.width||0);existing.height=Math.max(existing.height,info.height||0);return;}
    if(groups.size>=maxImages){truncated=true;return;}
    groups.set(key,{id:key,url:best.url,currentUrl:current.url,previewUrl:current.url,name:info.name||document.title,website:location.href,frameUrl:location.href,width:best.width||info.width||0,height:info.height||0,candidates:list.slice(0,12),discovery:info.kind});
  }
  for(const img of document.images){
    const candidates=[],width=Math.max(img.naturalWidth||0,img.width||0),height=Math.max(img.naturalHeight||0,img.height||0);
    const add=(url,source,priority=1,extra={})=>{if(url)candidates.push({url,source,priority,...extra});};
    add(img.currentSrc||img.src,'current',1,{width});add(img.getAttribute('src'),'src',0);
    for(const attr of ['data-original','data-full','data-full-src','data-zoom-image','data-large-image'])add(img.getAttribute(attr),attr,5);
    for(const attr of ['data-src','data-lazy-src','data-lazy','data-url'])add(img.getAttribute(attr),attr,2);
    for(const attr of ['srcset','data-srcset','data-lazy-srcset'])for(const c of srcset(img.getAttribute(attr)||''))add(c.url,attr,3,{width:c.width,density:c.density});
    if(img.parentElement?.tagName==='PICTURE')for(const source of img.parentElement.querySelectorAll('source')){if(source.media&&!matchMedia(source.media).matches)continue;for(const c of srcset(source.getAttribute('srcset')||source.getAttribute('data-srcset')||''))add(c.url,'picture',3,{width:c.width,density:c.density});}
    const anchor=img.closest('a[href]');if(anchor){const url=absolute(anchor.getAttribute('href'));if(url&&/\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?)(?:[?#]|$)/i.test(url))add(url,'linked-image',4);}
    collect(candidates,{current:img.currentSrc||img.src,width,height,name:img.alt||img.title,kind:'image'});
    if((img.currentSrc||img.src).startsWith('blob:')&&width&&height){try{const canvas=document.createElement('canvas'),scale=Math.min(1,128/width,128/height);canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);for(const group of groups.values())if(group.currentUrl===(img.currentSrc||img.src))group.previewUrl=canvas.toDataURL('image/jpeg',.75);}catch{}}
  }
  const elements=document.querySelectorAll('*');
  for(const el of elements){if(scannedElements++>=maxElements){truncated=true;break;}const style=getComputedStyle(el),background=style.backgroundImage;if(!background||background==='none')continue;const rect=el.getBoundingClientRect(),candidates=[];for(const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g))candidates.push({url:(match[1]??match[2]??match[3]).trim(),source:'background',priority:1});
    // A CSS declaration can contain multiple independent images, not srcset alternatives.
    for(const c of candidates){const url=absolute(c.url);if([...groups.values()].some(g=>g.candidates.some(v=>v.url===url)))continue;collect([c],{current:c.url,width:Math.round(rect.width),height:Math.round(rect.height),name:el.getAttribute('aria-label')||document.title,kind:'background'});}
  }
  if(truncated)warnings.push('页面超过本次扫描上限，结果可能不完整。');
  return {images:[...groups.values()],title:document.title,url:location.href,truncated,warnings,scannedElements};
}
