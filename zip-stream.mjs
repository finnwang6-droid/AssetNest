import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform,Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createInflateRaw} from 'node:zlib';
import {filePayload,isFilePayload} from './file-payload.mjs';
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xEDB88320^(n>>>1):n>>>1;return n>>>0;});
export function crcChunk(state,bytes){let c=state;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return c>>>0;}
const fail=message=>Object.assign(Error(message),{status:400});
export function safeZipName(name){if(!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.replace(/\/$/,'').split('/').some(p=>!p||p==='..'||p==='.'))throw fail('素材包包含无效路径：'+name);return name;}
function safeNumber(n){if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('ZIP64 数值超出范围');return Number(n);}
export function indexZipFile(file,{maxEntries=400000,maxExpanded=8*1024**3,maxEntry=256*1024**2}={}){
 const fd=fs.openSync(file,'r'),size=fs.statSync(file).size,caches=[];
 const read=(at,n)=>{if(at<0||at+n>size)throw fail('ZIP 数据范围无效');const hit=caches.find(c=>at>=c.at&&at+n<=c.at+c.bytes.length);if(hit)return hit.bytes.subarray(at-hit.at,at-hit.at+n);const bytes=Buffer.alloc(Math.min(size-at,Math.max(n,1024*1024)));if(fs.readSync(fd,bytes,0,bytes.length,at)!==bytes.length)throw fail('ZIP 文件不完整');caches.push({at,bytes});if(caches.length>2)caches.shift();return bytes.subarray(0,n);};
 try{
  const tailAt=Math.max(0,size-65557),tail=read(tailAt,size-tailAt);let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=tailAt+i;break;}if(end<0)throw fail('ZIP 目录损坏或文件不完整');const e=read(end,22);if(e.readUInt16LE(4)||e.readUInt16LE(6))throw fail('不支持分卷 ZIP');let count=e.readUInt16LE(10),centralSize=e.readUInt32LE(12),start=e.readUInt32LE(16),centralEnd=end;
  if(count===65535||centralSize===0xffffffff||start===0xffffffff){const locator=read(end-20,20);if(locator.readUInt32LE(0)!==0x07064b50||locator.readUInt32LE(4)!==0||locator.readUInt32LE(16)!==1)throw fail('ZIP64 定位记录无效');centralEnd=safeNumber(locator.readBigUInt64LE(8));const z=read(centralEnd,56);if(z.readUInt32LE(0)!==0x06064b50||z.readUInt32LE(16)||z.readUInt32LE(20)||z.readBigUInt64LE(24)!==z.readBigUInt64LE(32))throw fail('ZIP64 目录无效');count=safeNumber(z.readBigUInt64LE(32));centralSize=safeNumber(z.readBigUInt64LE(40));start=safeNumber(z.readBigUInt64LE(48));}
  else if(e.readUInt16LE(8)!==count)throw fail('ZIP 条目数不一致');
  if(count>maxEntries||start+centralSize!==centralEnd)throw fail('ZIP 条目数量或中央目录范围无效');const entries=[],seen=new Set();let offset=start,total=0;
  for(let i=0;i<count;i++){
   const h=read(offset,46);if(h.readUInt32LE(0)!==0x02014b50)throw fail('ZIP 中央目录损坏');const flags=h.readUInt16LE(8),method=h.readUInt16LE(10),crc=h.readUInt32LE(16),n=h.readUInt16LE(28),extraLength=h.readUInt16LE(30),comment=h.readUInt16LE(32);let compressed=h.readUInt32LE(20),original=h.readUInt32LE(24),local=h.readUInt32LE(42);const tail=read(offset+46,n+extraLength+comment),nameBytes=tail.subarray(0,n);let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);}catch{throw fail('只支持 UTF-8 ZIP 文件名');}safeZipName(name);const normalized=name.normalize('NFC').toLowerCase();if(seen.has(normalized))throw fail('ZIP 包含重复或大小写冲突条目：'+name);seen.add(normalized);if(flags&1||![0,8].includes(method)||(h.readUInt32LE(38)>>>16&0xf000)===0xa000)throw fail('不支持加密、链接或此压缩方式：'+name);
   if([compressed,original,local].includes(0xffffffff)){let found=false;for(let p=n;p+4<=n+extraLength;){const kind=tail.readUInt16LE(p),length=tail.readUInt16LE(p+2);if(p+4+length>n+extraLength)throw fail('ZIP 扩展字段损坏');if(kind===1){let q=p+4;for(const field of ['original','compressed','local']){const value=field==='original'?original:field==='compressed'?compressed:local;if(value!==0xffffffff)continue;if(q+8>p+4+length)throw fail('ZIP64 字段不完整');const decoded=safeNumber(tail.readBigUInt64LE(q));q+=8;if(field==='original')original=decoded;else if(field==='compressed')compressed=decoded;else local=decoded;}found=true;}p+=4+length;}if(!found)throw fail('缺少 ZIP64 扩展字段');}
   const localHeader=read(local,30);if(localHeader.readUInt32LE(0)!==0x04034b50||localHeader.readUInt16LE(8)!==method||localHeader.readUInt16LE(6)!==flags)throw fail('ZIP 本地记录不一致：'+name);const ln=localHeader.readUInt16LE(26),le=localHeader.readUInt16LE(28),dataAt=local+30+ln+le;if(!read(local+30,ln).equals(nameBytes)||dataAt+compressed>start)throw fail('ZIP 文件名或数据范围不一致：'+name);if(original>maxEntry||(total+=original)>maxExpanded)throw fail('素材包解压大小超出限制');if(name.endsWith('/')&&original)throw fail('ZIP 目录包含文件数据');entries.push({name,original,compressed,crc,method,dataAt,local});offset+=46+n+extraLength+comment;
  }
  if(offset!==centralEnd)throw fail('ZIP 中央目录长度无效');let previous=0;for(const entry of [...entries].sort((a,b)=>a.local-b.local)){if(entry.local<previous)throw fail('ZIP 条目数据重叠');previous=entry.dataAt+entry.compressed;}return {entries,total};
 }finally{fs.closeSync(fd);}
}
export async function extractZipFile(file,directory,index,{signal,onProgress=()=>{}}={}){
 const files={},start=path.resolve(directory);let completed=0;
 fs.mkdirSync(start,{recursive:true});let ordinal=0;
 // Archive display names may be invalid or too long on NTFS. Never use them as
 // extraction paths; retain the exact ZIP name only as the map key.
 for(const entry of index.entries){signal?.throwIfAborted();if(entry.name.endsWith('/'))continue;const target=path.join(start,String(ordinal++)+'.payload');let bytes=0,crc=0xffffffff;
  const check=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>entry.original)return done(fail('解压大小超出记录：'+entry.name));crc=crcChunk(crc,chunk);done(null,chunk);}}),input=entry.compressed?fs.createReadStream(file,{start:entry.dataAt,end:entry.dataAt+entry.compressed-1,highWaterMark:128*1024}):Readable.from([]);
  await pipeline(...(entry.method===8?[input,createInflateRaw(),check,fs.createWriteStream(target,{flags:'wx'})]:[input,check,fs.createWriteStream(target,{flags:'wx'})]),{signal});if(bytes!==entry.original||((crc^0xffffffff)>>>0)!==entry.crc)throw fail('ZIP 完整性校验失败：'+entry.name);files[entry.name]=filePayload(target);onProgress(++completed,index.entries.length);
 }return files;
}
export async function* encodeZip(entries,options={}){
 let chunks=[],size=0;for await(const chunk of zipChunks(entries,options)){if(size+chunk.length>128*1024&&size){yield Buffer.concat(chunks,size);chunks=[];size=0;}if(chunk.length>=128*1024)yield chunk;else{chunks.push(chunk);size+=chunk.length;}}if(size)yield Buffer.concat(chunks,size);
}
async function* zipChunks(entries,{signal,onProgress=()=>{}}={}){
 const central=[];let offset=0,count=0;const decoder=new TextEncoder();
 for(const entry of entries){signal?.throwIfAborted();const name=decoder.encode(safeZipName(entry.name)),size=isFilePayload(entry.data)?entry.data.length:entry.data.length;if(size>=0xffffffff)throw fail('单个文件超过当前流式导出上限');const localAt=offset,header=Buffer.alloc(30+name.length);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x808,6);header.writeUInt16LE(0x21,12);header.writeUInt16LE(name.length,26);header.set(name,30);yield header;offset+=header.length;let crc=0xffffffff,actual=0;const hash=entry.hash?crypto.createHash('sha256'):null;
  const source=isFilePayload(entry.data)?fs.createReadStream(entry.data.path,{highWaterMark:128*1024}):[Buffer.from(entry.data)];for await(const chunk of source){signal?.throwIfAborted();crc=crcChunk(crc,chunk);actual+=chunk.length;hash?.update(chunk);yield chunk;offset+=chunk.length;}if(actual!==size||hash&&hash.digest('hex')!==entry.hash)throw fail('导出原文件校验失败：'+entry.name);crc=(crc^0xffffffff)>>>0;const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(size,8);descriptor.writeUInt32LE(size,12);yield descriptor;offset+=16;
  const largeOffset=localAt>=0xffffffff,extra=largeOffset?12:0,h=Buffer.alloc(46+name.length+extra);h.writeUInt32LE(0x02014b50);h.writeUInt16LE(45,4);h.writeUInt16LE(largeOffset?45:20,6);h.writeUInt16LE(0x808,8);h.writeUInt16LE(0x21,14);h.writeUInt32LE(crc,16);h.writeUInt32LE(size,20);h.writeUInt32LE(size,24);h.writeUInt16LE(name.length,28);h.writeUInt16LE(extra,30);h.writeUInt32LE(largeOffset?0xffffffff:localAt,42);h.set(name,46);if(largeOffset){h.writeUInt16LE(1,46+name.length);h.writeUInt16LE(8,48+name.length);h.writeBigUInt64LE(BigInt(localAt),50+name.length);}central.push(h);onProgress(++count,offset);
 }
 const centralAt=offset;for(const bytes of central){signal?.throwIfAborted();yield bytes;offset+=bytes.length;}const centralSize=offset-centralAt,zip64=count>=65535||centralAt>=0xffffffff||centralSize>=0xffffffff;
 if(zip64){const z=Buffer.alloc(56),locator=Buffer.alloc(20);z.writeUInt32LE(0x06064b50);z.writeBigUInt64LE(44n,4);z.writeUInt16LE(45,12);z.writeUInt16LE(45,14);z.writeBigUInt64LE(BigInt(count),24);z.writeBigUInt64LE(BigInt(count),32);z.writeBigUInt64LE(BigInt(centralSize),40);z.writeBigUInt64LE(BigInt(centralAt),48);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(offset),8);locator.writeUInt32LE(1,16);yield z;yield locator;}
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(zip64?65535:count,8);end.writeUInt16LE(zip64?65535:count,10);end.writeUInt32LE(zip64?0xffffffff:centralSize,12);end.writeUInt32LE(zip64?0xffffffff:centralAt,16);yield end;
}
