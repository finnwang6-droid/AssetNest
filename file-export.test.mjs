import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {unzipSync} from 'fflate';
import {Catalog,digest} from './storage.mjs';
import {Transfers} from './transfers.mjs';
import {exportFilename,fileExportOptions,planFileExport} from './file-export.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-files-export-'));
function seed(c,id,bytes,{name='素材',ext='png',...extra}={}){const metadata=JSON.stringify({id,name,ext,size:bytes.length,tags:['keep'],folders:[],unknown:'preserved',...extra});c.commit({items:[{row:{id,metadata,file:id+'.info/'+id+'.'+ext,thumb:null,hash:digest(bytes)},source:{file_metadata:metadata,pack_id:null},files:{[id+'.'+ext]:bytes,'attachment.txt':Buffer.from('keep attachment')}}]});}
const png=await sharp({create:{width:80,height:40,channels:4,background:{r:180,g:90,b:40,alpha:.5}}}).png().toBuffer();
async function wait(t,job){await t.jobs.get(job.id).promise;return t.get(job.id);}
function archive(t,job){return unzipSync(fs.readFileSync(t.download(job.download.slice(10))));}

test('export names are safe, bounded, Unicode normalized and collision free on Windows',()=>{
 const used=new Set(),names=['A','a','A (2)','../CON','CON','e\u0301','é', 'x'.repeat(500)].map(n=>exportFilename(n,'png',used));assert.equal(new Set(names.map(n=>n.toLowerCase())).size,names.length);assert.equal(names[0],'A.png');assert.equal(names[1],'a (2).png');assert.ok(names.every(n=>!/[\\/]/.test(n)&&Buffer.byteLength(n)<240));assert.equal(names[4],'_CON.png');assert.equal(exportFilename('photo.png','png'),'photo.png');
 for(const bad of [{mode:'wrong'},{format:'pdf'},{quality:0},{maxEdge:-1},{maxEdge:10001},{background:'red'}])assert.throws(()=>fileExportOptions(bad));
});

test('original ZIP exports exact indexed bytes only, keeps same-name assets and leaves metadata and attachments unchanged',async()=>{
 const c=new Catalog(path.join(root,'original')),t=new Transfers(c);try{seed(c,'A',png);seed(c,'B',Buffer.from('PDF original'),{name:'素材',ext:'pdf'});seed(c,'C',png);const before=c.db.prepare('SELECT * FROM items ORDER BY id').all(),job=t.startFileExport(['A','B','C'],{mode:'original'});assert.throws(()=>t.assertIdle(),/文件导出任务/);const done=await wait(t,job);assert.equal(done.status,'completed',done.error);const files=archive(t,done);assert.deepEqual(Object.keys(files),['素材.png','素材.pdf','素材 (2).png']);assert.deepEqual(Buffer.from(files['素材.png']),png);assert.equal(Buffer.from(files['素材.pdf']).toString(),'PDF original');assert.deepEqual(c.db.prepare('SELECT * FROM items ORDER BY id').all(),before);assert.equal(fs.readFileSync(c.path('A.info/attachment.txt'),'utf8'),'keep attachment');assert.equal(done.results.length,3);
 }finally{await t.close();c.close();}
});

test('PNG and WebP conversion resize without enlargement and preserve alpha and originals',async()=>{
 for(const format of ['png','webp']){const c=new Catalog(path.join(root,format)),t=new Transfers(c);try{seed(c,'A',png);const before=c.row('A');let done=await wait(t,t.startFileExport(['A'],{mode:'convert',format,maxEdge:20,quality:100}));assert.equal(done.status,'completed',done.error);let files=archive(t,done),meta=await sharp(Buffer.from(files['素材.'+format])).metadata();assert.equal(meta.width,20);assert.equal(meta.height,10);assert.equal(meta.hasAlpha,true);assert.equal(done.results[0].width,20);done=await wait(t,t.startFileExport(['A'],{mode:'convert',format,maxEdge:500}));files=archive(t,done);meta=await sharp(Buffer.from(files['素材.'+format])).metadata();assert.equal(meta.width,80);assert.deepEqual(c.row('A'),before);assert.equal(digest(fs.readFileSync(c.path(before.file))),before.hash);
 }finally{await t.close();c.close();}}
});

test('JPG conversion applies orientation, removes EXIF and fills transparency with the chosen background',async()=>{
 const c=new Catalog(path.join(root,'jpg')),t=new Transfers(c);try{const oriented=await sharp({create:{width:80,height:40,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer(),transparent=await sharp({create:{width:20,height:10,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();seed(c,'A',oriented,{name:'方向',ext:'jpg'});seed(c,'B',transparent,{name:'透明'});
 const done=await wait(t,t.startFileExport(['A','B'],{mode:'convert',format:'jpg',maxEdge:40,quality:100,background:'#0000ff'}));assert.equal(done.status,'completed',done.error);const files=archive(t,done),meta=await sharp(Buffer.from(files['方向.jpg'])).metadata();assert.equal(meta.width,20);assert.equal(meta.height,40);assert.equal(meta.exif,undefined);assert.equal(meta.orientation,undefined);const pixel=await sharp(Buffer.from(files['透明.jpg'])).raw().toBuffer();assert.ok(pixel[0]<4&&pixel[1]<4&&pixel[2]>250);
 }finally{await t.close();c.close();}
});

test('multi-frame and damaged images fail the whole conversion and never publish a partial download',async()=>{
 const frame='21f904000a0000002c0000000001000100000202440100',animated=Buffer.from('47494638396101000100800000000000ffffff'+frame+frame+'3b','hex');assert.equal((await sharp(animated).metadata()).pages,2);
 const c=new Catalog(path.join(root,'invalid')),t=new Transfers(c);try{seed(c,'GOOD',png);seed(c,'ANIMATED',animated,{ext:'gif'});seed(c,'BROKEN',Buffer.from('not a PNG'));
 for(const id of ['ANIMATED','BROKEN']){const done=await wait(t,t.startFileExport(['GOOD',id],{mode:'convert'}));assert.equal(done.status,'failed');assert.equal(done.download,undefined);assert.deepEqual(done.results,[]);assert.ok(!fs.existsSync(path.join(t.root,done.id)));if(id==='ANIMATED')assert.match(done.error,/多帧或多页/);}const raw=await wait(t,t.startFileExport(['ANIMATED'],{mode:'original'}));assert.equal(raw.status,'completed');assert.deepEqual(Buffer.from(archive(t,raw)['素材.gif']),animated);
 }finally{await t.close();c.close();}
});

test('missing, unsupported, mutated and invalid selections are rejected without changing the library',async()=>{
 const c=new Catalog(path.join(root,'guards')),t=new Transfers(c);try{seed(c,'A',png);seed(c,'PDF',Buffer.from('pdf'),{ext:'pdf'});assert.throws(()=>planFileExport(c,[],{}),/1～500/);assert.throws(()=>planFileExport(c,['A','A'],{}),/1～500/);assert.throws(()=>planFileExport(c,['MISSING'],{}),/不存在/);assert.throws(()=>t.startFileExport(['PDF'],{mode:'convert'}),/不支持转换/);
 const row=c.row('A');fs.writeFileSync(c.path(row.file),'changed');for(const mode of ['original','convert']){const done=await wait(t,t.startFileExport(['A'],{mode}));assert.equal(done.status,'failed');assert.equal(done.download,undefined);assert.ok(!fs.existsSync(path.join(t.root,done.id)));}fs.unlinkSync(c.path(row.file));assert.throws(()=>t.startFileExport(['A']),/缺失/);assert.deepEqual(c.row('A'),row);
 }finally{await t.close();c.close();}
});

test('cancellation, disk limits, expiry and abandoned export cleanup preserve source files',async()=>{
 const c=new Catalog(path.join(root,'lifecycle'));let t=new Transfers(c);try{seed(c,'A',png);const job=t.startFileExport(['A'],{mode:'convert'});t.cancel(job.id);const cancelled=await wait(t,job);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.download,undefined);assert.ok(!t.busy);const old=c.space;c.space=()=>({bavail:0,bsize:4096});assert.throws(()=>t.startFileExport(['A']),/空间/);c.space=old;const done=await wait(t,t.startFileExport(['A']));const token=done.download.slice(10);t.jobs.get(done.id).expires=0;t.sweep();assert.throws(()=>t.download(token),/过期/);await t.close();const abandoned='00000000-0000-0000-0000-000000000000';fs.mkdirSync(path.join(t.root,abandoned));fs.writeFileSync(path.join(t.root,abandoned,'partial'),'unfinished');fs.writeFileSync(path.join(t.root,'keep.txt'),'keep');t=new Transfers(c);assert.ok(!fs.existsSync(path.join(t.root,abandoned)));assert.equal(fs.readFileSync(path.join(t.root,'keep.txt'),'utf8'),'keep');assert.equal(digest(fs.readFileSync(c.path(c.row('A').file))),digest(png));
 }finally{await t.close();c.close();}
});

process.env.ASSETNEST_DATA=path.join(root,'api');process.env.ASSETNEST_PORT='41774';const service=await import('./server.mjs'),base='http://127.0.0.1:41774';let headers;
before(async()=>{await new Promise(r=>service.server.listen(41774,'127.0.0.1',r));const b=await(await fetch(base+'/api/bootstrap')).json();headers={'Content-Type':'application/json','X-Assetnest-Key':b.key,'X-Assetnest-Library':b.libraryId};seed(service.catalog,'A',png);});
test('file export API enforces local auth and library identity and serves an expiring ZIP with the right filename',async()=>{
 const post=(p,extra={})=>fetch(base+'/api/jobs/files-export',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(p)}),p={ids:['A'],options:{mode:'original'}};
 for(const [extra,status]of [[{'X-Assetnest-Key':'bad'},401],[{Origin:'chrome-extension://example'},403],[{'X-Assetnest-Library':'wrong'},409],[{'X-Assetnest-Library':''},409]])assert.equal((await post(p,extra)).status,status);
 const r=await post(p);assert.equal(r.status,202);const job=await r.json();let done;for(let n=0;n<200;n++){done=await(await fetch(base+'/api/jobs/'+job.id,{headers})).json();if(done.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(done.status,'completed',done.error);assert.equal((await fetch(base+done.download,{headers:{Origin:'https://untrusted.test'}})).status,403);const download=await fetch(base+done.download);assert.match(download.headers.get('Content-Disposition'),/AssetNest-originals.zip/);assert.deepEqual(Buffer.from(unzipSync(new Uint8Array(await download.arrayBuffer()))['素材.png']),png);
});
after(async()=>{await service.watches.stop();await new Promise(r=>service.server.close(r));service.catalog.close();if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('assetnest-files-export-'))fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
