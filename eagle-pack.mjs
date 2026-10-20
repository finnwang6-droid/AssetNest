import fs from 'node:fs';
import path from 'node:path';
import {unzipSync,zipSync,strToU8} from 'fflate';
import {digest,fail,newId,validId} from './storage.mjs';
import {filePayload,payloadBytes,payloadHash} from './file-payload.mjs';
import {indexZipFile,extractZipFile} from './zip-stream.mjs';

const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xEDB88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let c=0xFFFFFFFF;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function object(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function json(bytes,name){try{if(bytes.length>128*1024*1024)throw Error('too large');const v=JSON.parse(payloadBytes(bytes).toString('utf8').replace(/^\uFEFF/,''));if(!object(v))throw Error('not object');return v;}catch{throw fail('JSON 记录无效或超过 128MB：'+name);}}
function zipEntries(bytes){
 bytes=Buffer.from(bytes);let end=-1;for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)if(bytes.readUInt32LE(n)===0x06054b50&&n+22+bytes.readUInt16LE(n+20)===bytes.length){end=n;break;}
 if(end<0)throw fail('ZIP 目录损坏或文件不完整');
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw fail('暂不支持分卷 ZIP');
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
 if(count===65535||size===0xFFFFFFFF||start===0xFFFFFFFF)throw fail('暂不支持 ZIP64 大型素材包');
 if(count>30000||start+size!==end||bytes.readUInt16LE(end+8)!==count)throw fail('ZIP 目录数量或范围无效');
 const entries=[],seen=new Set();let offset=start,total=0;
 for(let i=0;i<count;i++){
  if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw fail('ZIP 中央目录损坏');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),original=bytes.readUInt32LE(offset+24),n=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
  if(offset+46+n+extra+comment>end)throw fail('ZIP 文件名范围无效');
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset+46,offset+46+n));}catch{throw fail('暂不支持非 UTF-8 的 ZIP 文件名');}
  if(!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(p=>p==='..'||p==='.')||name.replace(/\/$/,'').split('/').some(p=>!p))throw fail('素材包包含无效路径：'+name);
  if(seen.has(name))throw fail('ZIP 包含重复条目：'+name);seen.add(name);
  if(flags&1||![0,8].includes(method))throw fail('加密或不支持的 ZIP 压缩方式：'+name);
  const mode=bytes.readUInt32LE(offset+38)>>>16;if((mode&0xF000)===0xA000)throw fail('素材包包含符号链接：'+name);
  total+=original;if(original>100*1024*1024||total>512*1024*1024)throw fail('素材包解压大小超出限制');
  if(local+30>start||bytes.readUInt32LE(local)!==0x04034b50)throw fail('ZIP 本地条目损坏：'+name);
  const ln=bytes.readUInt16LE(local+26),le=bytes.readUInt16LE(local+28);
  if(local+30+ln+le+compressed>start||!bytes.subarray(local+30,local+30+ln).equals(bytes.subarray(offset+46,offset+46+n)))throw fail('ZIP 文件名或数据范围不一致：'+name);
  entries.push({name,original,crc});offset+=46+n+extra+comment;
 }
 if(offset!==end)throw fail('ZIP 中央目录长度无效');return {entries,total};
}
function same(a,b){if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));if(object(a)||object(b))return object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));return a===b;}
function validateItem(m){if(!object(m)||!validId(m.id)||typeof m.name!=='string'||!m.name||/[\/\\\x00]/.test(m.name)||m.name.length>1000||typeof m.ext!=='string'||!/^[a-z0-9]{1,12}$/i.test(m.ext))throw fail('素材记录的 ID、名称或格式无效');for(const k of ['tags','folders'])if(m[k]!==undefined&&(!Array.isArray(m[k])||m[k].some(v=>typeof v!=='string')))throw fail(m.id+' 的 '+k+' 格式无效');}
export function preparePack(catalog,bytes){
 if(bytes.length>256*1024*1024)throw fail('素材包超过 256MB');
 const directory=zipEntries(bytes);catalog.assertSpace(directory.total*2+bytes.length);
 let files;try{files=unzipSync(bytes);}catch{throw fail('ZIP 解压失败，文件可能损坏');}
 for(const e of directory.entries){if(!files[e.name]||files[e.name].length!==e.original||crc32(files[e.name])!==e.crc)throw fail('ZIP 完整性校验失败：'+e.name);}
 return preparePackFiles(catalog,files,directory,digest(bytes));
}
export async function preparePackDisk(catalog,file,directory,options={}){
 const index=indexZipFile(file);catalog.assertSpace(index.total*2+fs.statSync(file).size);
 const files=await extractZipFile(file,directory,index,options);
 return preparePackFiles(catalog,files,index,payloadHash(filePayload(file)));
}
function preparePackFiles(catalog,files,directory,sourceSha256){
 const keys=Object.keys(files).filter(k=>k==='pack.json'||k.endsWith('/pack.json'));if(keys.length!==1)throw fail('必须存在唯一的 pack.json');
 const packKey=keys[0],prefix=packKey.slice(0,-9),pack=json(files[packKey],packKey);if(!Array.isArray(pack.images))throw fail('pack.json 缺少 images');
 const used=new Set([packKey]),seenItems=new Set(),folderMap=new Map(),folderPlans=[],incomingFolders=[],seenFolders=new Set();
 function scanFolder(f,parent=null,depth=0){
  if(depth>64||!object(f)||!validId(f.id)||typeof f.name!=='string'||f.children!==undefined&&!Array.isArray(f.children)||seenFolders.has(f.id.toLowerCase()))throw fail('文件夹记录无效或重复：'+(f?.id||'?'));
  seenFolders.add(f.id.toLowerCase());incomingFolders.push({raw:f,parent});for(const c of f.children||[])scanFolder(c,f.id,depth+1);
 }
 if(pack.folder!==undefined&&pack.folder!==null)scanFolder(pack.folder);if(pack.folders!==undefined){if(!Array.isArray(pack.folders))throw fail('folders 必须为数组');for(const f of pack.folders)scanFolder(f);}
 const report={id:newId(),createdAt:Date.now(),baseRevision:catalog.db.prepare('SELECT COUNT(*) AS n FROM committed_transactions').get().n,sourceSha256,total:pack.images.length,imported:0,duplicates:0,conflicts:0,contentDuplicates:0,folderConflicts:0,updated:0,linkedSources:0,folder:pack.folder?.name||null,policy:'preserve-existing-create-new-on-conflict',entries:[],warnings:[]};
 const existingFolders=catalog.folders();const reservedFolders=new Set(existingFolders.map(f=>f.id.toLowerCase()));
 for(const f of incomingFolders){const old=existingFolders.find(x=>x.id.toLowerCase()===f.raw.id.toLowerCase());let id=f.raw.id;if(old&&(!same(JSON.parse(old.metadata),f.raw)||old.id!==id||old.parent_id!==f.parent)){do{id=newId();}while(reservedFolders.has(id.toLowerCase()));report.folderConflicts++;report.warnings.push({kind:'folder-remapped',from:f.raw.id,to:id});}folderMap.set(f.raw.id,id);reservedFolders.add(id.toLowerCase());}
 function remapFolder(f){const raw=structuredClone(f);raw.id=folderMap.get(f.id);if(Array.isArray(f.children))raw.children=f.children.map(remapFolder);return raw;}
 // If an ancestor is remapped, an existing descendant must also get a private ID.
 for(const f of incomingFolders){const old=existingFolders.find(x=>x.id===f.raw.id);if(old&&folderMap.get(f.raw.id)===f.raw.id&&(folderMap.get(f.parent)||null)!==(old.parent_id||null)){let id;do{id=newId();}while(reservedFolders.has(id.toLowerCase()));reservedFolders.add(id.toLowerCase());folderMap.set(f.raw.id,id);report.folderConflicts++;report.warnings.push({kind:'folder-remapped',from:f.raw.id,to:id});}}
 for(const f of incomingFolders)folderPlans.push({id:folderMap.get(f.raw.id),raw:remapFolder(f.raw),parentId:folderMap.get(f.parent)||null});
 const envelope=structuredClone(pack);delete envelope.images;if(pack.folder)envelope.folder=remapFolder(pack.folder);if(pack.folders)envelope.folders=pack.folders.map(remapFolder);
 const packId=newId(),plans=[],reserved=new Set();report.packId=packId;
 for(const m of pack.images){
  validateItem(m);if(seenItems.has(m.id.toLowerCase()))throw fail('素材包内 ID 重复：'+m.id);seenItems.add(m.id.toLowerCase());
  const dir=`${prefix}${m.id}.info/`,original=dir+`${m.name}.${m.ext}`,thumbName=dir+`${m.name}_thumbnail.png`,metadataName=dir+'metadata.json';
  if(!files[original])throw fail('素材包缺少原文件：'+original);used.add(original);
  if(m.size!==undefined&&(!Number.isSafeInteger(m.size)||m.size!==files[original].length))throw fail('素材文件大小与记录不一致：'+m.id);
  const disk=files[metadataName]?json(files[metadataName],metadataName):null;if(disk){used.add(metadataName);for(const k of ['id','name','ext'])if(disk[k]!==undefined&&disk[k]!==m[k])throw fail('pack 与 metadata 标识不一致：'+m.id+'/'+k);if(!same(disk,m))report.warnings.push({kind:'metadata-fields-differ-preserved',id:m.id});}
  if(files[thumbName])used.add(thumbName);
  const raw=structuredClone(m),diskRaw=disk?structuredClone(disk):null;
  for(const record of [raw,diskRaw].filter(Boolean)){if(record.folders!==undefined&&!Array.isArray(record.folders))throw fail('文件夹引用格式无效：'+m.id);if(Array.isArray(record.folders))record.folders=record.folders.map(id=>{if(folderMap.has(id))return folderMap.get(id);if(existingFolders.some(f=>f.id===id))return id;throw fail('素材引用不存在的文件夹：'+id);});}
  const hash=payloadHash(files[original]),old=catalog.db.prepare('SELECT * FROM items WHERE id=? COLLATE NOCASE').get(m.id);let id=m.id,action='added';
  if(old){const s=catalog.source(old.id),oldPack=s?.pack_id?catalog.db.prepare('SELECT envelope FROM packs WHERE id=?').get(s.pack_id):null;const contextSame=!s?.pack_id||oldPack&&same(JSON.parse(oldPack.envelope),envelope);
   if(old.id===id&&old.hash===hash&&same(JSON.parse(old.metadata),raw)&&same(s?.file_metadata?JSON.parse(s.file_metadata):null,diskRaw)&&contextSame){report.duplicates++;let action='unchanged';if(!s?.pack_id){plans.push({row:old,source:{file_metadata:s?.file_metadata??null,pack_id:packId}});report.linkedSources++;action='linked-source';}report.entries.push({id,originalId:m.id,action,hash});continue;}
   do{id=catalog.allocate();}while(reserved.has(id.toLowerCase()));raw.id=id;if(diskRaw)diskRaw.id=id;report.conflicts++;action=old.hash!==hash?'content-conflict-copy':!contextSame?'pack-context-conflict-copy':'metadata-conflict-copy';
  }else if(fs.existsSync(path.join(catalog.images,id+'.info'))){throw fail('存在未索引的同名素材目录，请先检查：'+id);}
  if(reserved.has(id.toLowerCase()))throw fail('导入 ID 冲突：'+id);reserved.add(id.toLowerCase());
  if(catalog.db.prepare('SELECT id FROM items WHERE hash=?').get(hash)){report.contentDuplicates++;if(action==='added')action='same-content-distinct-id';}
  const internal='original.'+m.ext.toLowerCase(),thumb=files[thumbName]?'thumbnail.png':null;
  const data={[internal]:files[original]};if(thumb)data[thumb]=files[thumbName];
  plans.push({row:{id,metadata:JSON.stringify(raw),file:`${id}.info/${internal}`,thumb:thumb?`${id}.info/${thumb}`:null,hash},source:{file_metadata:diskRaw?JSON.stringify(diskRaw):null,pack_id:packId},files:data});
  report.imported++;report.entries.push({id,originalId:m.id,action,hash});
 }
 const unexpected=Object.keys(files).filter(k=>!k.endsWith('/')&&!used.has(k));if(unexpected.length)throw fail('素材包包含尚不支持的附加文件，未导入：'+unexpected.slice(0,3).join('、'));
 report.expandedBytes=directory.total;report.space=catalog.assertSpace(plans.reduce((n,p)=>n+(p.files?Object.values(p.files).reduce((s,v)=>s+v.length,0):fs.statSync(catalog.path(p.row.file)).size+(p.row.thumb?fs.statSync(catalog.path(p.row.thumb)).size:0)),0)+Buffer.byteLength(JSON.stringify(envelope)));
 return {items:plans,folders:folderPlans,pack:{id:packId,envelope},report};
}
export function commitPack(catalog,plan){if(catalog.db.prepare('SELECT COUNT(*) AS n FROM committed_transactions').get().n!==plan.report.baseRevision)throw fail('预检后素材库已变化，请重新预检',409);catalog.commit(plan);return {...plan.report,committed:true};}
export function exportPack(catalog,ids=null){
 return zipSync(Object.fromEntries(packExportEntries(catalog,ids).map(e=>{const bytes=payloadBytes(e.data);if(e.hash&&digest(bytes)!==e.hash)throw fail('原图完整性校验失败：'+e.name);return [e.name,bytes];})),{level:0});
}
export function packExportEntries(catalog,ids=null){
 if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>!validId(id))))throw fail('导出选择必须为素材 ID 数组');
 const rows=ids?catalog.db.prepare('SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(JSON.stringify(ids)):catalog.db.prepare("SELECT * FROM items WHERE coalesce(json_extract(metadata,'$.isDeleted'),0)=0").all(),files={},hashes={},images=[];
 const packIds=new Set(rows.map(r=>catalog.source(r.id)?.pack_id).filter(Boolean));
 const onlyPack=[...packIds][0];const fullSource=packIds.size===1&&rows.every(r=>catalog.source(r.id)?.pack_id===onlyPack)&&rows.length===catalog.db.prepare('SELECT COUNT(*) AS n FROM item_sources WHERE pack_id=?').get(onlyPack).n;
 let envelope={};if(packIds.size===1&&rows.every(r=>catalog.source(r.id)?.pack_id===[...packIds][0]))envelope=JSON.parse(catalog.db.prepare('SELECT envelope FROM packs WHERE id=?').get([...packIds][0]).envelope);
 else if(packIds.size>0)throw fail('所选素材来自多个来源，请按导入批次分别导出，以免根元数据合并丢失');
 for(const row of rows){const m=JSON.parse(row.metadata);validateItem(m);images.push(m);const base=`${m.id}.info/`,original=filePayload(catalog.path(row.file)),key=base+`${m.name}.${m.ext}`;files[key]=original;hashes[key]=row.hash;const source=catalog.source(row.id);const expected=source?.file_metadata||row.metadata;if(!same(JSON.parse(fs.readFileSync(path.join(catalog.images,row.id+'.info/metadata.json'),'utf8')),JSON.parse(expected)))throw fail('元数据与索引不一致，请先检查素材库：'+row.id);if(source?.file_metadata!==null)files[base+'metadata.json']=strToU8(source?.file_metadata||row.metadata);if(row.thumb)files[base+`${m.name}_thumbnail.png`]=filePayload(catalog.path(row.thumb));}
 const all=catalog.folders(),needed=new Set(images.flatMap(m=>m.folders||[]));
 function includeOriginal(f){if(!f)return;needed.add(f.id);for(const child of f.children||[])includeOriginal(child);}
 if(fullSource){includeOriginal(envelope.folder);for(const f of envelope.folders||[])includeOriginal(f);}
 else if(envelope.folder)needed.add(envelope.folder.id);
 for(const id of [...needed]){let r=all.find(f=>f.id===id),seen=new Set();while(r?.parent_id&&!seen.has(r.id)){seen.add(r.id);needed.add(r.parent_id);r=all.find(f=>f.id===r.parent_id);}}
 function tree(f){const raw=JSON.parse(f.metadata);if(Object.hasOwn(raw,'children')||all.some(c=>c.parent_id===f.id))raw.children=all.filter(c=>c.parent_id===f.id&&needed.has(c.id)).map(tree);return raw;}
 const roots=all.filter(f=>needed.has(f.id)&&(!f.parent_id||!needed.has(f.parent_id))).map(tree);
 if(Object.hasOwn(envelope,'folder')){envelope.folder=roots.length===1?roots[0]:roots.length>1?{id:'ASSETNEST_EXPORT',name:'拾素材',children:roots,tags:[],modificationTime:Date.now()}:envelope.folder;}
 else if(Object.hasOwn(envelope,'folders'))envelope.folders=roots;
 else if(roots.length)envelope.folder=roots.length===1?roots[0]:{id:'ASSETNEST_EXPORT',name:'拾素材',children:roots,tags:[],modificationTime:Date.now()};
 files['pack.json']=strToU8(JSON.stringify({...envelope,images}));const entries=Object.entries(files).map(([name,data])=>({name,data,hash:hashes[name]}));
 if(files['pack.json'].length>128*1024**2||entries.length>400000||entries.some(e=>e.data.length>256*1024**2)||entries.reduce((n,e)=>n+e.data.length+92+Buffer.byteLength(e.name)*2,98)>4*1024**3)throw fail('导出超过当前素材包限制（4GB／40 万文件／单文件 256MB／JSON 128MB），请分批选择');
 return entries;
}
