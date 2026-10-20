import {fail} from './storage.mjs';
export function decodeImageData(data,maxBytes=32*1024*1024){
 if(typeof data!=='string')throw fail('图片内容格式无效');const m=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(data);if(!m)throw fail('图片内容需要为有效的 base64 图片');
 const types={'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/svg+xml':'svg','image/bmp':'bmp','image/x-icon':'ico','image/vnd.microsoft.icon':'ico','image/tiff':'tiff'};
 const ext=types[m[1].toLowerCase()];if(!ext)throw fail('暂不支持此图片内容类型：'+m[1]);
 if(m[2].length>Math.ceil(maxBytes*4/3)+8)throw fail('图片内容超过大小限制',413);const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>maxBytes)throw fail('图片为空或超过大小限制',413);
 const magic=ext==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):ext==='jpg'?bytes[0]===255&&bytes[1]===216:ext==='gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()):ext==='webp'?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP':ext==='svg'?/<svg[\s>]/i.test(bytes.subarray(0,8192).toString()):true;
 if(!magic)throw fail('图片内容与声明格式不一致');return {bytes,ext};
}
export function captureMetadata(p){
 const tags=p.tags??[];if(!Array.isArray(tags)||tags.length>100||tags.some(t=>typeof t!=='string'||t.length>1000))throw fail('标签格式无效');
 for(const value of [p.url,p.website,p.frameUrl].filter(v=>v!==undefined&&v!==null))if(typeof value!=='string')throw fail('来源网址格式无效');
 const sourceImageURL=/^(https?:|blob:)/i.test(p.url||'')?p.url:null;if(sourceImageURL?.length>16384||String(p.website||'').length>16384)throw fail('来源网址过长');
 const meta={name:p.name||'网页图片',url:p.website||sourceImageURL||'',tags,folders:p.folderId?[p.folderId]:[],annotation:typeof p.annotation==='string'?p.annotation:'',sourceImageURL,captureKind:['image','visible-screenshot','region-screenshot'].includes(p.captureKind)?p.captureKind:'image',acquisition:['browser','page','inline','local-download'].includes(p.acquisition)?p.acquisition:'local-download'};
 if(p.frameUrl)meta.sourceFrameURL=p.frameUrl;if(typeof p.candidateSource==='string')meta.candidateSource=p.candidateSource.slice(0,100);
 for(const k of ['width','height'])if(Number.isInteger(p[k])&&p[k]>0&&p[k]<1000000)meta[k]=p[k];return meta;
}
export function bookmarkData(p){
 if(typeof p.url!=='string'||p.url.length>16384||/[\r\n]/.test(p.url))throw fail('网页地址无效');let url;try{url=new URL(p.url);}catch{throw fail('网页地址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('网页收藏只支持 HTTP/HTTPS 地址');
 const metadata={...captureMetadata({...p,url:url.href,website:url.href}),name:p.name||url.hostname,ext:'url',bookmark:true,captureKind:'bookmark',sourceImageURL:null};
 const thumbnail=p.thumbnail?decodeImageData(p.thumbnail,8*1024*1024):null;if(thumbnail&&thumbnail.ext!=='png')throw fail('网页预览缩略图需要为 PNG');
 return {metadata,bytes:Buffer.from('[InternetShortcut]\r\nURL='+url.href+'\r\n','utf8'),thumbnail:thumbnail?.bytes||null};
}
