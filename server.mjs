import {MaintenanceJobs} from './maintenance-jobs.mjs';
import {Trash} from './trash.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
import {Catalog,digest} from './storage.mjs';
import {preparePack,commitPack,exportPack as encodePack} from './eagle-pack.mjs';
import {createBackup} from './backup.mjs';
import {decodeImageData,captureMetadata,bookmarkData} from './capture-input.mjs';
import {Libraries} from './libraries.mjs';
import {batchEdit,manageTag,editFolder,deleteFolder,prepareEdit} from './organize.mjs';
import {queryItems,searchFacets,searchIds,validateConditions} from './search.mjs';
import {FeatureAnalyzer,similarImages} from './features.mjs';
import {execFile} from 'node:child_process';
import {formatKind,mediaMime,byteRange,rasterPreview} from './formats.mjs';
import {assetName} from './local-layout.mjs';
import {Transfers} from './transfers.mjs';
import {diagnostics} from './diagnostics.mjs';
import {encodeZip} from './zip-stream.mjs';
import {packExportEntries} from './eagle-pack.mjs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {desktopAction} from './desktop-actions.mjs';
import {psdDimensions,psdFileDimensions} from './psd-preview.mjs';
import {PreviewTasks} from './preview-tasks.mjs';
import sharp from 'sharp';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
let DATA=path.resolve(process.env.ASSETNEST_DATA||path.join(ROOT,'data'));
const PORT=Number(process.env.ASSETNEST_PORT||41600);
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
const EXTENSION_VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'extension/manifest.json'),'utf8')).version;
fs.mkdirSync(path.join(DATA,'images'),{recursive:true});
const keyPath=path.join(DATA,'connection-key');
if(!fs.existsSync(keyPath))fs.writeFileSync(keyPath,crypto.randomBytes(32).toString('hex'));
const KEY=fs.readFileSync(keyPath,'utf8').trim();
const collectorLogPath=path.join(path.dirname(keyPath),'collector-status.json');
let collectorLog={revision:0,events:[],job:null};try{const j=JSON.parse(fs.readFileSync(collectorLogPath,'utf8'));if(Array.isArray(j.events))collectorLog=j;}catch{}
function recordCapture(event){const entry={...event,seq:++collectorLog.revision,at:Date.now()};collectorLog.events=[entry,...collectorLog.events].slice(0,100);try{fs.writeFileSync(collectorLogPath+'.tmp',JSON.stringify(collectorLog));fs.renameSync(collectorLogPath+'.tmp',collectorLogPath);}catch{}return entry;}
function captureResult(result,name){const row=catalog.row(result.item.id);if(!row||!fs.existsSync(catalog.path(row.file))||digest(fs.readFileSync(catalog.path(row.file)))!==row.hash)throw error('保存校验失败：原图未完整写入素材库',500);recordCapture({status:result.duplicatePending?'awaiting-duplicate':result.duplicate?'duplicate':'saved',name:name||result.item.name,itemId:result.item.id,folders:result.item.folders||[],libraryId:LIBRARY_ID,path:DATA});return {...result,destination:{libraryId:LIBRARY_ID,path:DATA,folders:result.item.folders||[]},verified:!result.duplicatePending};}
const libraries=new Libraries(DATA,{config:process.env.ASSETNEST_CONFIG||path.join(DATA,'libraries.json')});
let catalog=libraries.catalog,db=catalog.db;DATA=catalog.root;
let LIBRARY_ID=catalog.libraryId;
let transfers=new Transfers(catalog);
let analyzer=new FeatureAnalyzer(catalog);analyzer.schedule();
let previews=new PreviewTasks(catalog);let trash=new Trash(catalog);let maintenance=new MaintenanceJobs(catalog,transfers);
const mime={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',mp4:'video/mp4',pdf:'application/pdf',html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',ico:'image/x-icon'};
const validID=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(s);
const uid=()=>Date.now().toString(36).toUpperCase()+crypto.randomBytes(4).toString('hex').toUpperCase();
const parseRow=r=>{if(!r)return null;const m=JSON.parse(r.metadata),exists=fs.existsSync(catalog.path(r.file));return {tags:[],folders:[],url:'',annotation:'',isDeleted:false,size:exists?fs.statSync(catalog.path(r.file)).size:0,modificationTime:0,...m,...(exists&&m.ext.toLowerCase()==='psd'&&!m.width?(()=>{try{return psdFileDimensions(catalog.path(r.file));}catch{return {};}})():{}),hasThumbnail:!!r.thumb,missingOriginal:!exists,hash:r.hash,importBatch:catalog.source(r.id)?.pack_id||null};};
const allItems=()=>db.prepare('SELECT * FROM items').all().map(parseRow);
const allFolders=()=>catalog.folders().map(r=>({...JSON.parse(r.metadata),children:[],parentId:r.parent_id}));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const error=(msg,status=400)=>Object.assign(new Error(msg),{status});
async function body(req,limit=64*1024*1024){let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>limit)throw error('文件超过允许的大小',413);chunks.push(c);}return Buffer.concat(chunks);}
async function input(req){return JSON.parse((await body(req)).toString('utf8')||'{}');}
function addFolder(f,parentId=null){if(!validID(f.id))throw error('文件夹 ID 无效');if(parentId&&!db.prepare('SELECT id FROM folders WHERE id=?').get(parentId))throw error('父文件夹不存在');const raw={...f};delete raw.parentId;catalog.commit({folders:[{id:f.id,raw,parentId}]});}
function dimensions(bytes,ext){try{if(ext.toLowerCase()==='psd')return psdDimensions(bytes);if(ext==='png')return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};if(ext==='gif')return {width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};if(['jpg','jpeg'].includes(ext)){let i=2;while(i<bytes.length-10){if(bytes[i++]!==255)continue;const m=bytes[i++];if(m===0xD8||m===0xD9)continue;const l=bytes.readUInt16BE(i);if([0xC0,0xC1,0xC2,0xC3].includes(m))return {height:bytes.readUInt16BE(i+3),width:bytes.readUInt16BE(i+5)};if(l<2)break;i+=l;}}}catch{}return {};}
function readReceipt(key,requestHash=null){
 if(db.prepare('SELECT key FROM purged_receipts WHERE key=?').get(key))throw error('此任务的素材已被彻底删除，请取消旧任务后重新采集',409);const row=db.prepare('SELECT * FROM capture_receipts WHERE key=?').get(key);if(!row)return null;if(requestHash&&row.request_hash!==requestHash)throw error('任务回执键与请求内容不一致',409);const result=JSON.parse(row.result),item=catalog.row(result.itemId);if(!item||!fs.existsSync(catalog.path(item.file)))throw error('已提交任务的原文件缺失，请先检查素材库');const metadata=parseRow(item);if(metadata.isDeleted)throw error('此前任务的素材已移入回收站；请恢复素材，或取消旧任务后重新采集',409);if(digest(fs.readFileSync(catalog.path(item.file)))!==item.hash)throw error('此前任务的原图校验失败，请先检查素材库',409);return {item:metadata,duplicate:result.duplicate};
}
function receiptFor(p,kind){if(!p.idempotencyKey)return null;if(typeof p.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{10,80}:\d{1,3}$/.test(p.idempotencyKey))throw error('采集任务回执键无效');return {key:p.idempotencyKey,requestHash:digest(Buffer.from(JSON.stringify({kind,url:p.url,name:p.name,website:p.website,tags:p.tags,folderId:p.folderId}))) };}
async function saveItem(meta,bytes,thumb=null,{dedupe=true,receipt=null,duplicateMode='reuse'}={}){
 if(!['ask','reuse','keep'].includes(duplicateMode))throw error('重复素材处理方式无效');
 const owner=catalog;
 if(!thumb&&['jpg','jpeg','png'].includes(String(meta.ext).toLowerCase())){try{const image=sharp(bytes,{limitInputPixels:40000000,pages:1}).timeout({seconds:15}).rotate(),info=await image.metadata(),w=info.autoOrient?.width||info.width,h=info.autoOrient?.height||info.height;meta={...meta,width:w,height:h};if((w>960||h>960||bytes.length>15000000||(meta.ext==='png'&&bytes.length>1048576))&&w&&h){const scale=Math.max(w,h)>320?320/Math.min(w,h):1,tw=Math.floor(w*scale),th=Math.floor(h*scale);if(tw*th<=40000000)thumb=await image.resize(tw,th,{fit:'fill'}).webp({quality:75}).toBuffer();}}catch{}}
 if(owner!==catalog)throw error('目标素材库已切换，请重新提交采集',409);
 transfers.assertIdle();
 if(receipt){const previous=readReceipt(receipt.key,receipt.requestHash);if(previous)return previous;}
 const hash=digest(bytes);
 if(dedupe&&duplicateMode!=='keep'){const old=db.prepare('SELECT * FROM items WHERE hash=?').get(hash);if(old&&fs.existsSync(catalog.path(old.file))&&digest(fs.readFileSync(catalog.path(old.file)))===hash){
  if(duplicateMode==='ask')return {item:parseRow(old),duplicate:true,duplicatePending:true};
  const current=parseRow(old),patch={tags:[...new Set([...(current.tags||[]),...(meta.tags||[])])],folders:[...new Set([...(current.folders||[]),...(meta.folders||[])])],isDeleted:false};
  catalog.commit({items:[prepareEdit(catalog,old.id,patch)],receipt:receipt?{...receipt,result:{itemId:old.id,duplicate:true}}:null});return {item:parseRow(catalog.row(old.id)),duplicate:true};}}
 const id=catalog.allocate();
 const ext=String(meta.ext||'bin').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12)||'bin';
 const name=assetName(meta.name,DATA,id,ext),file=`${id}.info/${name}.${ext}`,thumbnail=thumb?`${id}.info/${name}_thumbnail.png`:null,now=Date.now();
 const metadata={...meta,id,name,ext,tags:Array.isArray(meta.tags)?meta.tags.map(String):[],folders:Array.isArray(meta.folders)?meta.folders:[],url:String(meta.url||''),annotation:String(meta.annotation||''),isDeleted:!!meta.isDeleted,size:bytes.length,btime:now,mtime:now,lastModified:now,modificationTime:meta.modificationTime||now,...dimensions(bytes,ext),...(meta.width&&meta.height?{width:meta.width,height:meta.height}:{})};
 if(metadata.folders.some(id=>!db.prepare('SELECT id FROM folders WHERE id=?').get(id)))throw error('目标文件夹不存在');
 if(!thumbnail)metadata.noThumbnail=true;
 const files={[name+'.'+ext]:bytes};if(thumb)files[name+'_thumbnail.png']=thumb;
 catalog.commit({items:[{row:{id,metadata:JSON.stringify(metadata),file,thumb:thumbnail,hash},source:{file_metadata:JSON.stringify(metadata),pack_id:null},files}],receipt:receipt?{...receipt,result:{itemId:id,duplicate:false}}:null});
 previews.enqueue(catalog.row(id));
 return {item:{...metadata,hash},duplicate:false};
}
export function importPack(bytes){
 return commitPack(catalog,preparePack(catalog,bytes));
}
export function exportPack(ids=null){return encodePack(catalog,ids);}
const needsLocation=()=>process.env.ASSETNEST_REQUIRE_LOCATION==='1'&&!libraries.locationConfirmed;
function activate(next){void maintenance.close();analyzer.stop();void transfers.close();void previews.stop();catalog=next;db=catalog.db;DATA=catalog.root;LIBRARY_ID=catalog.libraryId;transfers=new Transfers(catalog);analyzer=new FeatureAnalyzer(catalog);analyzer.schedule();previews=new PreviewTasks(catalog);trash=new Trash(catalog);maintenance=new MaintenanceJobs(catalog,transfers);}
let pickerBusy=false;
async function pickDirectory(){
 if(pickerBusy)throw error('文件夹选择窗口已打开',409);const helper=[path.join(ROOT,'FolderPicker.exe'),path.join(ROOT,'desktop/bin/FolderPicker.exe')].find(f=>fs.existsSync(f));if(!helper)throw error('文件夹选择器未安装，请输入完整路径');pickerBusy=true;
 try{return await new Promise((resolve,reject)=>execFile(helper,[DATA],{windowsHide:true,timeout:180000,encoding:'utf8'},(e,out)=>{if(e)return reject(error('文件夹选择已取消或超时，可手动输入路径'));try{resolve(JSON.parse(out.replace(/^\uFEFF/,'')));}catch{reject(error('无法读取选择的文件夹'));}}));}finally{pickerBusy=false;}
}
async function download(url){let u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw error('仅支持 HTTP/HTTPS 图片地址');const response=await fetch(u,{signal:AbortSignal.timeout(45000)});if(!response.ok)throw error('图片下载失败：HTTP '+response.status);const type=(response.headers.get('content-type')||'').split(';')[0];if(!type.startsWith('image/'))throw error('地址未返回图片，请尝试插件的图片内容采集');if(Number(response.headers.get('content-length'))>50*1024*1024)throw error('单张图片超过 50MB');const chunks=[];let size=0;for await(const c of response.body){size+=c.length;if(size>50*1024*1024)throw error('单张图片超过 50MB');chunks.push(c);}return {bytes:Buffer.concat(chunks),ext:type.split('/')[1].replace('jpeg','jpg').replace('svg+xml','svg')};}
const server=http.createServer(async(req,res)=>{
 let captureAttempt=null;
 try{
 const expected=`127.0.0.1:${PORT}`;if(![expected,`localhost:${PORT}`].includes(req.headers.host))throw error('Host 不允许',403);
 const origin=req.headers.origin;const ownOrigins=[`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`];const extension=origin?.startsWith('chrome-extension://');
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 if(extension){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Assetnest-Key,X-File-Name,X-Assetnest-Library');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');}
 if(req.method==='OPTIONS'){res.writeHead(extension||ownOrigins.includes(origin)?204:403);res.end();return;}
 const u=new URL(req.url,`http://${expected}`),route=u.pathname;
 if(route==='/api/health')return json(res,200,{name:'AssetNest',version:VERSION,libraryId:LIBRARY_ID,storageConfigured:!needsLocation()});
 if(route==='/api/bootstrap'){if(origin&&!ownOrigins.includes(origin)||req.headers['sec-fetch-site']==='cross-site')throw error('来源不允许',403);return json(res,200,{key:KEY,port:PORT,dataPath:DATA,startupDataPath:path.dirname(keyPath),libraryId:LIBRARY_ID,extensionPath:path.join(ROOT,'extension'),needsLocation:needsLocation()});}
 if(route.startsWith('/download/')&&req.method==='GET'){if(origin&&!ownOrigins.includes(origin)||req.headers['sec-fetch-site']==='cross-site')throw error('来源不允许',403);const file=transfers.download(route.slice(10));res.writeHead(200,{'Content-Type':'application/zip','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store','Content-Disposition':'attachment; filename=AssetNest.eaglepack'});await pipeline(fs.createReadStream(file),res);return;}
 if(route.startsWith('/api/')){
 if(req.headers['x-assetnest-key']!==KEY)throw error('连接密钥无效，请在软件设置中复制密钥',401);
 if(origin&&!extension&&!ownOrigins.includes(origin))throw error('来源不允许',403);
 const readPost=route==='/api/collector-status'||route==='/api/search'||route==='/api/shutdown'||route.startsWith('/api/previews/')||route==='/api/cache/clear'||route.startsWith('/api/jobs/')&&route.endsWith('/cancel'),requestLibrary=LIBRARY_ID,checkLibrary=(allowBusy=false)=>{if(!allowBusy&&req.method!=='GET'&&!readPost)transfers.assertIdle();if(requestLibrary!==LIBRARY_ID||req.headers['x-assetnest-library']&&req.headers['x-assetnest-library']!==LIBRARY_ID)throw error('目标素材库已切换，请刷新后重试',409);};checkLibrary();if(req.method!=='GET'&&!readPost)transfers.assertIdle();
 res.once('finish',()=>{if(req.method!=='GET')analyzer.schedule();});
 if(needsLocation()&&['/api/upload','/api/capture','/api/bookmark','/api/import-pack','/api/import-confirm'].includes(route))throw error('请先在拾素材中选择素材库保存位置',409);
 if(route==='/api/search'&&req.method==='POST'){const p=await input(req);checkLibrary();let conditions=p.conditions||{};if(p.smartId){const smart=db.prepare('SELECT conditions FROM smart_folders WHERE id=?').get(p.smartId);if(!smart)throw error('智能文件夹不存在',404);conditions=JSON.parse(smart.conditions);}const result=queryItems(catalog,conditions,{page:p.page,limit:p.limit});if(p.idsOnly){const ids=searchIds(catalog,conditions);return json(res,200,{ids,total:ids.length});}return json(res,200,{...result,rows:undefined,items:result.rows.map(row=>({...parseRow(row),width:row.analyzed_width||parseRow(row).width,height:row.analyzed_height||parseRow(row).height,extractedPalette:row.extracted_palette?JSON.parse(row.extracted_palette):[],analysisStatus:row.analysis_status||'pending'}))});}
 if(route==='/api/facets'&&req.method==='GET'){catalog.refreshExternal?.();const facets=searchFacets(catalog);return json(res,200,{...facets,folders:allFolders().map(f=>({...f,count:facets.folders.find(c=>c.id===f.id)?.n||0})),smartFolders:db.prepare('SELECT * FROM smart_folders ORDER BY name,id').all().map(s=>({...s,conditions:JSON.parse(s.conditions)}))});}
 if(route==='/api/diagnostics'&&req.method==='GET')return json(res,200,diagnostics(catalog));
 if(route.startsWith('/api/desktop/')&&req.method==='POST'){if(extension||process.env.ASSETNEST_DESKTOP!=='1')throw error('此操作请在桌面客户端中使用',403);const p=await input(req);checkLibrary();return json(res,200,await desktopAction(catalog,route.slice(13),p.id));}
 if(route==='/api/cache/clear'&&req.method==='POST'){if(extension)throw error('请在软件中清理缓存',403);const result=await previews.clear();checkLibrary();return json(res,200,result);}
 if(route==='/api/previews'&&req.method==='GET')return json(res,200,previews.status());
 if(route==='/api/previews/settings'&&req.method==='POST'){if(extension)throw error('请在软件中设置缩略图任务',403);const p=await input(req);checkLibrary();const result=await previews.configure(p);checkLibrary();return json(res,200,result);}
 if(route==='/api/previews/retry'&&req.method==='POST'){if(extension)throw error('请在软件中重试缩略图任务',403);checkLibrary();return json(res,200,previews.retry());}
 if(route==='/api/jobs'&&req.method==='GET')return json(res,200,{...transfers.list(),jobs:[...maintenance.list(),...transfers.list().jobs]});
 if(route==='/api/jobs/maintenance-defaults'&&req.method==='GET'){if(extension)throw error('请在软件中维护素材库',403);return json(res,200,{rebuildTarget:maintenance.defaultTarget()});}
 if(route==='/api/jobs/maintenance'&&req.method==='POST'){if(extension)throw error('请在软件中维护素材库',403);const p=await input(req);checkLibrary();return json(res,202,maintenance.start(p.type,{target:p.target}));}
 if(route==='/api/jobs/export'&&req.method==='POST'){if(extension)throw error('请在软件中导出素材包',403);const p=await input(req);checkLibrary();return json(res,202,transfers.startExport(p.ids??null));}
 if(route.startsWith('/api/jobs/')){if(extension)throw error('请在软件中管理任务',403);const parts=route.split('/');if(parts.length===4&&req.method==='GET')return json(res,200,maintenance.owns(parts[3])?maintenance.get(parts[3]):transfers.get(parts[3]));if(parts.length===5&&parts[4]==='cleanup'&&req.method==='POST')return json(res,200,maintenance.cleanupJob(parts[3]));if(parts.length===5&&parts[4]==='cancel'&&req.method==='POST')return json(res,200,maintenance.owns(parts[3])?maintenance.cancel(parts[3]):transfers.cancel(parts[3]));}
 if(route==='/api/smart-folders'&&req.method==='POST'){if(extension)throw error('请在软件中编辑智能文件夹',403);const p=await input(req);checkLibrary();if(p.remove){db.prepare('DELETE FROM smart_folders WHERE id=?').run(p.id);return json(res,200,{removed:true});}if(typeof p.name!=='string'||!p.name.trim()||p.name.length>200)throw error('智能文件夹名称无效');const conditions=validateConditions(p.conditions),id=p.id||uid();if(p.id&&!db.prepare('SELECT id FROM smart_folders WHERE id=?').get(id))throw error('智能文件夹不存在',404);db.prepare('INSERT OR REPLACE INTO smart_folders VALUES(?,?,?)').run(id,p.name.trim(),JSON.stringify(conditions));return json(res,200,{id,name:p.name.trim(),conditions});}
 if(route==='/api/features'&&req.method==='GET')return json(res,200,analyzer.status());
 if(route==='/api/features/run'&&req.method==='POST'){analyzer.schedule();return json(res,200,analyzer.status());}
 if(route.startsWith('/api/similar/')&&req.method==='GET')return json(res,200,similarImages(catalog,route.slice(13),{distance:u.searchParams.get('distance')??10}));
 if(route==='/api/shutdown'&&req.method==='POST'&&process.env.ASSETNEST_DESKTOP==='1'){if(extension)throw error('仅桌面启动器可退出服务',403);analyzer.stop();await Promise.all([maintenance.close(),transfers.close(),previews.stop()]);json(res,200,{stopping:true});server.close(()=>{catalog.close();process.exit(0);});return;}

 if(route.startsWith('/api/libraries')){
  if(extension)throw error('请在拾素材软件中管理素材库',403);
  if(route==='/api/libraries'&&req.method==='GET')return json(res,200,libraries.list());
  if(route==='/api/libraries/rescan'&&req.method==='POST'){const p=await input(req);checkLibrary();const result=catalog.refreshExternal?.(true)||{changed:false};analyzer.schedule();return json(res,200,{...result,...libraries.list()});}
  if(route==='/api/libraries/picker'&&req.method==='POST')return json(res,200,await pickDirectory());
  if(route==='/api/libraries/setup'&&req.method==='POST'){const p=await input(req);checkLibrary();libraries.setup(p);activate(libraries.catalog);return json(res,200,{...libraries.list(),dataPath:DATA});}
  if(route==='/api/libraries'&&req.method==='POST'){const p=await input(req);checkLibrary();return json(res,200,libraries.register(p));}
  if(route==='/api/libraries/switch'&&req.method==='POST'){const p=await input(req);checkLibrary();activate(libraries.switch(p.directory));return json(res,200,{...libraries.list(),dataPath:DATA});}
 }
 if(route==='/api/batch-edit'&&req.method==='POST'){const p=await input(req);checkLibrary();return json(res,200,batchEdit(catalog,p));}
 if(route==='/api/tags/manage'&&req.method==='POST'){const p=await input(req);checkLibrary();return json(res,200,manageTag(catalog,p));}
 if(route.startsWith('/api/folders/')&&req.method==='PATCH'){const p=await input(req);checkLibrary();return json(res,200,editFolder(catalog,route.slice(13),p));}
 if(route.startsWith('/api/folders/')&&req.method==='DELETE'){if(extension)throw error('请在软件中删除文件夹',403);checkLibrary();return json(res,200,deleteFolder(catalog,route.slice(13)));}
 if(route==='/api/extension-download'&&req.method==='GET'){const files={};for(const name of fs.readdirSync(path.join(ROOT,'extension')).filter(n=>/\.(?:js|json|html|css|png|svg)$/.test(n)))if(fs.lstatSync(path.join(ROOT,'extension',name)).isFile())files['assetnest-extension/'+name]=fs.readFileSync(path.join(ROOT,'extension',name));res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename=assetnest-extension-${EXTENSION_VERSION}.zip`});res.end(zipSync(files,{level:6}));return;}
 if(route==='/api/items'&&req.method==='GET')return json(res,200,{items:allItems(),folders:allFolders(),library:{id:LIBRARY_ID,path:DATA}});
 if(route==='/api/trash/preview'&&req.method==='POST'){if(extension)throw error('请在拾素材客户端中清理回收站',403);const p=await input(req);return json(res,200,trash.preview(p.ids===undefined?null:p.ids));}
 if(route==='/api/trash/confirm'&&req.method==='POST'){if(extension)throw error('请在拾素材客户端中清理回收站',403);const p=await input(req),owner=catalog,worker=previews;await worker.stop();await worker.ready;try{checkLibrary();if(owner!==catalog)throw error('目标素材库已切换',409);const result=trash.confirm(p.token),warnings=[];for(const name of worker.cache.entries.keys())if(!db.prepare('SELECT id FROM items WHERE hash=? LIMIT 1').get(name.slice(0,64)))try{if(!worker.cache.remove(name))warnings.push('预览缓存仍在使用：'+name);}catch(e){warnings.push('预览缓存未清理：'+e.message);}return json(res,200,{...result,warnings});}finally{if(owner===catalog)previews=new PreviewTasks(catalog);}}
 if(route==='/api/trash/cleanup'&&req.method==='POST'){if(extension)throw error('请在拾素材客户端中清理回收站',403);const result=catalog.recover();return json(res,200,{recovered:result,pendingCleanup:fs.existsSync(catalog.transactions)&&fs.readdirSync(catalog.transactions).length>0});}
 if(route==='/api/collector-status'&&req.method==='GET')return json(res,200,{revision:collectorLog.revision,job:collectorLog.job,recovery:collectorLog.recovery||null,libraryId:LIBRARY_ID,path:DATA,events:collectorLog.events.filter(e=>e.libraryId===LIBRARY_ID).slice(0,30)});
 if(route==='/api/collector-recovery'&&req.method==='POST'){if(extension)throw error('请在拾素材客户端中恢复任务',403);const p=await input(req);if(!collectorLog.job||collectorLog.job.id!==p.jobId||collectorLog.job.status!=='paused')throw error('待恢复任务已变化',409);collectorLog.recovery={jobId:p.jobId,libraryId:LIBRARY_ID,createdAt:Date.now(),resolved:false};recordCapture({status:'task',libraryId:LIBRARY_ID,jobId:p.jobId});return json(res,200,{ok:true,recovery:collectorLog.recovery});}
 if(route==='/api/collector-status'&&req.method==='POST'){const p=await input(req);if(typeof p.id!=='string'||p.id.length>80||!['running','paused','waiting-service','awaiting-duplicate','completed','cancelled'].includes(p.status))throw error('采集任务状态无效');if(collectorLog.recovery&&collectorLog.recovery.jobId===p.previousJobId&&collectorLog.recovery.libraryId===p.targetLibraryId)collectorLog.recovery.resolved=true;collectorLog.job={id:p.id,status:p.status,index:Math.max(0,Math.min(100,Number(p.index)||0)),total:Math.max(0,Math.min(100,Number(p.total)||0)),error:String(p.error||'').slice(0,500),targetLibraryId:String(p.targetLibraryId||''),updatedAt:Date.now()};recordCapture({status:'task',libraryId:LIBRARY_ID,jobId:p.id});return json(res,200,{ok:true});}
 if(route==='/api/capture-receipt'&&req.method==='GET'){const key=u.searchParams.get('key');if(!key||!/^[A-Za-z0-9_-]{10,80}:\d{1,3}$/.test(key))throw error('任务回执键无效');const result=readReceipt(key);return json(res,200,{found:!!result,result:result?captureResult(result):null});}
 if(route==='/api/integrity'&&req.method==='GET')return json(res,200,catalog.integrity());
 if(route==='/api/backup'&&req.method==='POST')return json(res,200,createBackup(catalog));
 if(route==='/api/import-reports'&&req.method==='GET')return json(res,200,db.prepare('SELECT report FROM import_reports ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.report)));
 if(route==='/api/import-preview'&&req.method==='POST')return json(res,200,await transfers.preview(req,{check:()=>checkLibrary(true)}));
 if(route==='/api/import-confirm'&&req.method==='POST'){const p=await input(req);checkLibrary();transfers.assertIdle();try{return json(res,200,commitPack(catalog,transfers.takePreview(p.token)));}finally{transfers.cancelPreview(p.token);}}
 if(route==='/api/import-cancel'&&req.method==='POST'){const p=await input(req);checkLibrary();transfers.cancelPreview(p.token);return json(res,200,{cancelled:true});}
 if(route==='/api/folders'&&req.method==='POST'){const p=await input(req);checkLibrary();if(!String(p.name||'').trim())throw error('请输入文件夹名称');const f={id:uid(),name:p.name.trim(),children:[],parentId:p.parentId||null,modificationTime:Date.now(),tags:[]};addFolder(f,f.parentId);return json(res,200,f);}
 if(route==='/api/capture'&&req.method==='POST'){const p=await input(req);checkLibrary();captureAttempt={name:String(p.name||'网页图片').slice(0,300),libraryId:LIBRARY_ID,path:DATA};recordCapture({...captureAttempt,status:'downloading'});const receipt=receiptFor(p,'image');if(receipt){const previous=readReceipt(receipt.key,receipt.requestHash);if(previous)return json(res,200,previous);}const metadata=captureMetadata(p);let bytes,ext;if(p.base64)({bytes,ext}=decodeImageData(p.base64));else({bytes,ext}=await download(p.url));checkLibrary();if(bytes.length>50*1024*1024)throw error('图片超过 50MB');return json(res,200,captureResult(await saveItem({...metadata,ext},bytes,null,{receipt,duplicateMode:p.duplicateMode}),p.name));}
 if(route==='/api/bookmark'&&req.method==='POST'){const inputData=await input(req);checkLibrary();captureAttempt={name:String(inputData.name||'网页收藏').slice(0,300),libraryId:LIBRARY_ID,path:DATA};recordCapture({...captureAttempt,status:'downloading'});const receipt=receiptFor(inputData,'bookmark');if(receipt){const previous=readReceipt(receipt.key,receipt.requestHash);if(previous)return json(res,200,previous);}const p=bookmarkData(inputData);return json(res,200,captureResult(await saveItem(p.metadata,p.bytes,p.thumbnail,{receipt,duplicateMode:inputData.duplicateMode}),inputData.name));}
 if(route==='/api/upload'&&req.method==='POST'){const bytes=await body(req,256*1024*1024);checkLibrary();const name=decodeURIComponent(req.headers['x-file-name']||'file.bin');const ext=path.extname(name).slice(1);if(!/^[a-z0-9]{1,12}$/i.test(ext))throw error('文件需要有效的扩展名（1～12 位字母或数字）');return json(res,200,await saveItem({name:path.basename(name,path.extname(name)),ext,tags:[],folders:[]},bytes));}
 if(route==='/api/import-pack'&&req.method==='POST'){const preview=await transfers.preview(req,{check:()=>checkLibrary(true)});try{return json(res,200,commitPack(catalog,transfers.takePreview(preview.token)));}finally{transfers.cancelPreview(preview.token);}}
 if(route==='/api/export-pack'&&req.method==='POST'){const p=await input(req);checkLibrary();await transfers.exclusive(async()=>{const entries=packExportEntries(catalog,p.ids??null);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':"attachment; filename=AssetNest.eaglepack"});await pipeline(Readable.from(encodeZip(entries)),res);});return;}
 if(route.startsWith('/api/items/')&&req.method==='PATCH'){const p=await input(req);checkLibrary();return json(res,200,catalog.updateItem(route.slice(11),p));}
 throw error('接口不存在',404);
 }
 if(route.startsWith('/media/')){
  if(req.headers['x-assetnest-library']&&req.headers['x-assetnest-library']!==LIBRARY_ID)throw error('目标素材库已切换',409);
  if(!['GET','HEAD'].includes(req.method))throw error('请求方法不允许',405);
  const parts=route.split('/'),row=db.prepare('SELECT * FROM items WHERE id=?').get(parts[2]);if(!row)throw error('素材不存在',404);if(!['thumb','original','preview'].includes(parts[3])||parts.length!==4)throw error('文件不存在',404);
  const meta=JSON.parse(row.metadata),kind=formatKind(meta.ext),owner=catalog,previewOwner=previews;
  if(parts[3]==='thumb'&&!row.thumb&&!['image','raster'].includes(kind)){const icon=fs.readFileSync(path.join(ROOT,'public/file.svg'));res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end(icon);return;}
  let full;if(parts[3]==='thumb'&&!row.thumb){full=await previewOwner.thumbnail(row);if(!full&&kind==='raster'){res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(ROOT,'public/file.svg')));return;}}
  if(!full)full=parts[3]==='preview'?await rasterPreview(owner,row):owner.path(parts[3]==='thumb'?(row.thumb||row.file):row.file);
  const unpin=previewOwner.cache.pin(full),releasePreview=()=>{unpin();if(previewOwner.alive())previewOwner.cache.enforce();};previewOwner.cache.register(full);previewOwner.cache.touch(full);res.once('finish',releasePreview);res.once('close',releasePreview);previewOwner.cache.enforce();
  const size=fs.statSync(full).size,range=byteRange(req.headers.range,size);if(range===false){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
  const handle=fs.openSync(full,'r'),magic=Buffer.alloc(12);try{fs.readSync(handle,magic,0,12,0);}finally{fs.closeSync(handle);}const contentType=magic.toString('ascii',0,4)==='RIFF'&&magic.toString('ascii',8,12)==='WEBP'?'image/webp':null;const headers={'Content-Type':contentType||mediaMime[path.extname(full).slice(1).toLowerCase()]||'application/octet-stream','Content-Length':range?range.end-range.start+1:size,'Accept-Ranges':'bytes','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'"};
  if(u.searchParams.has('download')||kind==='file'&&parts[3]==='original')headers['Content-Disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(meta.name+'.'+meta.ext).replace(/['()]/g,c=>'%'+c.charCodeAt(0).toString(16));if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range?206:200,headers);if(req.method==='HEAD')res.end();else fs.createReadStream(full,range||{}).on('error',()=>res.destroy()).pipe(res);return;
 }
 const name=route==='/'?'index.html':route.slice(1);if(!/^vendor\/pdfjs\/(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+\.(?:bcmap|pfb|ttf|wasm|js)$/.test(name)&&!/^vendor\/folder-icons\/[a-zA-Z0-9_-]+\.(?:png|svg)$/.test(name)&&!['maintenance-ui.js','trash.js','collector.js','collector.css','folder-drop.js','classification.css','preview-tasks.js','preview-tasks.css','folders.css','folder-icons.js','index.html','style.css','panels.css','context-menu.js','app.js','viewer.js','bookmark.svg','file.svg','favicon.ico','vendor/pdf.mjs','vendor/pdf.worker.mjs'].includes(name))throw error('文件不存在',404);const file=path.join(ROOT,'public',name);if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw error('文件不存在',404);res.writeHead(200,{'Content-Type':name.endsWith('.wasm')?'application/wasm':name.endsWith('.mjs')?'text/javascript; charset=utf-8':(mime[path.extname(file).slice(1)]||'application/octet-stream'),'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; font-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'"});fs.createReadStream(file).pipe(res);
 }catch(e){if(captureAttempt)recordCapture({...captureAttempt,status:'failed',message:String(e.message).slice(0,500)});console.error(e.message);if(!res.headersSent)json(res,e.status||400,{error:e.message});else res.end();}
});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(PORT,'127.0.0.1',()=>console.log(`拾素材已启动 http://127.0.0.1:${PORT}\n素材目录：${DATA}`));
export {server,db,DATA,catalog,previews};
