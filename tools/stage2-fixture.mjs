import http from 'node:http';
import {deflateSync} from 'node:zlib';
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xEDB88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let c=0xFFFFFFFF;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function chunk(name,data){const type=Buffer.from(name),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);type.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([type,data])),data.length+8);return b;}
export function fixturePng(width,height,color){const rows=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++){const offset=y*(width*4+1);for(let x=0;x<width;x++){const at=offset+1+x*4;rows[at]=color[0];rows[at+1]=color[1];rows[at+2]=color[2];rows[at+3]=255;}}const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
export function createFixture(port=41611){
 const urls=['/small.png','/large.png','/picture.png','/lazy.png','/thumb.png','/original.jpg','/bg-one.png','/bg-two.png','/blob-source.png','/authenticated.png','/frame.png','/late.png','/slow.png','/receipt-image.png'];
 const images=new Map(urls.map((url,i)=>[url,fixturePng(url==='/large.png'?320:80,url==='/large.png'?240:60,[(i*47+20)%256,(i*71+60)%256,(i*31+100)%256])]));
 images.set('/placeholder.png',fixturePng(1,1,[240,240,240]));let slow=false;const requests=[];
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${port}`);requests.push({path:url.pathname,referer:req.headers.referer||'',cookie:!!req.headers.cookie});
  if(url.pathname==='/fixture'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'assetnestFixture=allow; SameSite=Lax; Path=/'});
   res.end(`<!doctype html><html><head><meta charset="utf-8"><title>AssetNest 固定采集测试页</title><style>body{font:16px sans-serif;background:#eef1fa;padding:25px;min-height:2200px}img{width:100px;height:75px;object-fit:contain}.background{width:140px;height:90px;background-image:url('/bg-one.png'),url('/bg-two.png')}iframe{width:180px;height:100px}h1{color:#616bd7}.region-target{width:220px;height:130px;background:#e65a91}</style></head><body><h1>固定采集测试页</h1><p>原图候选、懒加载、背景图、Blob 和登录态测试</p><img id="responsive" src="/small.png" sizes="50px" srcset="/small.png 100w, /large.png?sig=keep&amp;size=original 1200w" alt="响应式图片"><picture><source media="(min-width:700px)" srcset="/picture.png 800w"><img src="/small.png" alt="picture 图片"></picture><img id="lazy" src="/placeholder.png" data-src="/lazy.png" width="160" height="120" alt="懒加载"><a href="/original.jpg"><img src="/thumb.png" alt="链接原图"></a><img src="/large.png?sig=keep&amp;size=original" alt="重复 URL"><img id="blob" alt="Blob 图片"><img id="auth" src="/authenticated.png" alt="登录态图片"><div class="background" aria-label="多层背景"></div><iframe src="/frame"></iframe><div class="region-target">区域截图测试</div><div style="height:900px"></div><div id="late"></div><script>(async()=>{const blob=await(await fetch('/blob-source.png')).blob();const image=document.querySelector('#blob');image.src=URL.createObjectURL(blob);await image.decode();window.__fixtureReady=true;})();let loaded=false;addEventListener('scroll',()=>{if(!loaded&&scrollY>600){loaded=true;const image=new Image();image.src='/late.png';image.alt='滚动后加载';document.querySelector('#late').append(image);}});</script></body></html>`);return;
  }
  if(url.pathname==='/frame'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<img src="/frame.png" width="120" height="90" alt="frame image">');return;}
  if(url.pathname==='/authenticated.png'&&(!req.headers.cookie?.includes('assetnestFixture=allow')||!req.headers.referer?.includes('/fixture'))){res.writeHead(403);res.end('requires page session and referer');return;}
  if(url.pathname==='/gone.png'){res.writeHead(404);res.end('missing');return;}
  if(url.pathname==='/slow.png'&&slow)await new Promise(resolve=>setTimeout(resolve,4000));
  const data=images.get(url.pathname);if(data){res.writeHead(200,{'Content-Type':'image/png','Content-Length':data.length});res.end(data);return;}
  res.writeHead(404);res.end();
 });
 return {server,images,requests,setSlow:value=>slow=value};
}
