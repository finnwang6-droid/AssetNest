import fs from 'node:fs';
import sharp from 'sharp';
export const ALGORITHM='phash-dct32-palette-v1';
sharp.concurrency(1);sharp.cache({memory:32,files:0,items:20});
export function perceptualHash(gray){
 if(gray.length!==1024)throw Error('pHash requires 32x32 grayscale pixels');const values=[];
 for(let v=0;v<8;v++)for(let u=0;u<8;u++){let sum=0;for(let y=0;y<32;y++)for(let x=0;x<32;x++)sum+=gray[y*32+x]*Math.cos((2*x+1)*u*Math.PI/64)*Math.cos((2*y+1)*v*Math.PI/64);values.push(sum);}
 const sorted=values.slice(1).sort((a,b)=>a-b),median=sorted[31];let result=0n;for(let i=1;i<64;i++)result=(result<<1n)|(values[i]>median?1n:0n);return result.toString(16).padStart(16,'0');
}
export function hamming(a,b){let n=BigInt('0x'+a)^BigInt('0x'+b),count=0;while(n){n&=n-1n;count++;}return count;}
export function extractPalette(rgba){const bins=new Map();let pixels=0;for(let i=0;i<rgba.length;i+=4){if(rgba[i+3]<32)continue;pixels++;const key=(rgba[i]>>5)*64+(rgba[i+1]>>5)*8+(rgba[i+2]>>5),bin=bins.get(key)||{sum:[0,0,0],n:0};for(let c=0;c<3;c++)bin.sum[c]+=rgba[i+c];bin.n++;bins.set(key,bin);}return [...bins.values()].sort((a,b)=>b.n-a.n).slice(0,8).map(b=>({color:b.sum.map(v=>Math.round(v/b.n)),ratio:Math.round(b.n/Math.max(1,pixels)*10000)/100}));}
export async function analyzeFile(file){
 if(fs.statSync(file).size>100*1024*1024)throw Error('原文件超过分析上限 100MB');
 const image=sharp(file,{limitInputPixels:40e6,animated:false,failOn:'error'}).timeout({seconds:15}).rotate(),meta=await image.metadata();
 if(!['jpeg','png','webp','gif','avif','tiff','heif'].includes(meta.format))throw Error('此格式尚不支持图像特征分析');
 const oriented=meta.autoOrient||meta;const pixels=await image.clone().resize(96,96,{fit:'inside',withoutEnlargement:false}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
 const gray=await image.clone().flatten({background:'#ffffff'}).resize(32,32,{fit:'fill'}).greyscale().raw().toBuffer();
 return {width:oriented.width||meta.width,height:oriented.height||meta.height,palette:extractPalette(pixels),phash:perceptualHash(gray)};
}
export class FeatureAnalyzer{
 constructor(catalog){this.catalog=catalog;this.stopped=false;this.active=null;this.timer=null;}
 stop(){this.stopped=true;clearTimeout(this.timer);}
 schedule(){if(this.stopped||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.run().catch(()=>{});},100);this.timer.unref?.();}
 run(){if(this.active)return this.active;this.active=this.work().finally(()=>this.active=null);return this.active;}
 async work(){const c=this.catalog;while(!this.stopped&&c.db.isOpen){const row=c.db.prepare('SELECT i.* FROM items i LEFT JOIN image_features f ON f.id=i.id WHERE f.id IS NULL OR f.hash<>i.hash OR f.algorithm<>? LIMIT 1').get(ALGORITHM);if(!row)return;let status='ready',feature={},message=null;try{feature=await analyzeFile(c.path(row.file));}catch(e){status='unsupported';message=e.message.slice(0,500);}if(this.stopped||!c.db.isOpen)return;const current=c.row(row.id);if(!current||current.hash!==row.hash)continue;
 c.db.prepare('INSERT OR REPLACE INTO image_features VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.hash,ALGORITHM,status,feature.width||null,feature.height||null,feature.palette?JSON.stringify(feature.palette):null,feature.phash||null,message);await new Promise(r=>setTimeout(r,5));}}
 status(){const db=this.catalog.db,all=db.prepare('SELECT count(*) AS n FROM items').get().n,states=db.prepare('SELECT f.status,count(*) AS n FROM image_features f JOIN items i ON i.id=f.id AND i.hash=f.hash WHERE f.algorithm=? GROUP BY f.status').all(ALGORITHM);return {algorithm:ALGORITHM,total:all,ready:states.find(s=>s.status==='ready')?.n||0,unsupported:states.find(s=>s.status==='unsupported')?.n||0,pending:all-states.reduce((n,s)=>n+s.n,0),running:!!this.active,diagnostics:db.prepare("SELECT f.id,json_extract(i.metadata,'$.name') AS name,f.error FROM image_features f JOIN items i ON i.id=f.id AND i.hash=f.hash WHERE f.status<>'ready' LIMIT 50").all()};}
}
export function similarImages(catalog,id,{distance=10,limit=50}={}){
 distance=Number(distance);limit=Number(limit);if(!Number.isInteger(distance)||distance<0||distance>32||!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(Error('相似度参数无效'),{status:400});
 const db=catalog.db,source=db.prepare("SELECT f.*,i.hash AS original_hash FROM image_features f JOIN items i ON i.id=f.id AND i.hash=f.hash WHERE f.id=? AND f.status='ready' AND f.algorithm=?").get(id,ALGORITHM);if(!source)throw Object.assign(Error('此素材尚未完成图像分析，或该格式不支持；请稍后重试'),{status:409});
 const color=JSON.parse(source.palette||'[]')[0]?.color||[255,255,255],matches=[];
 for(const row of db.prepare("SELECT f.*,i.hash AS original_hash FROM image_features f JOIN items i ON i.id=f.id AND i.hash=f.hash WHERE f.status='ready' AND f.algorithm=? AND f.id<>? AND NOT coalesce(json_extract(i.metadata,'$.isDeleted'),0)").all(ALGORITHM,id)){
  const difference=hamming(source.phash,row.phash),palette=JSON.parse(row.palette||'[]'),rgb=palette[0]?.color||[255,255,255],colorDistance=Math.hypot(...rgb.map((v,n)=>v-color[n])),ratioDifference=Math.abs(Math.log((row.width/row.height)/(source.width/source.height)));
  if(row.original_hash===source.original_hash||difference<=distance&&colorDistance<=90&&ratioDifference<=.3)matches.push({id:row.id,distance:difference,colorDistance:Math.round(colorDistance),exactContent:row.original_hash===source.original_hash});
 }matches.sort((a,b)=>Number(b.exactContent)-Number(a.exactContent)||a.distance-b.distance||a.colorDistance-b.colorDistance||a.id.localeCompare(b.id));return {sourceId:id,algorithm:ALGORITHM,threshold:distance,total:matches.length,candidates:matches.slice(0,limit),reviewRequired:true};
}
