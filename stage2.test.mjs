import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CaptureQueue} from './extension/queue.js';
import {captureError,localError} from './extension/capture-error.js';
import {decodeImageData,captureMetadata,bookmarkData} from './capture-input.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-stage2-'));process.env.ASSETNEST_DATA=root;process.env.ASSETNEST_PORT='41606';
const {server,catalog,db}=await import('./server.mjs');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=';
const base='http://127.0.0.1:41606';let headers;
before(async()=>{await new Promise(r=>server.listen(41606,'127.0.0.1',r));headers={'Content-Type':'application/json','X-Assetnest-Key':(await(await fetch(base+'/api/bootstrap')).json()).key};});
function setup(capture){let stored;return {q:new CaptureQueue({read:async()=>structuredClone(stored),write:async j=>stored=structuredClone(j),capture}),get:()=>structuredClone(stored)};}
const item={url:'https://example.com/image.png',name:'测试图片'};
test('service outages keep the current item pending and preserve its idempotency key on resume',async()=>{
 let offline=true;const keys=[];const {q,get}=setup(async(_,context)=>{keys.push(context.key);if(offline)throw captureError('SERVICE_UNAVAILABLE','offline',{retryable:true});return {duplicate:false,item:{id:'NEW'}};});
 await q.enqueue([item]);await q.run();assert.equal(get().status,'waiting-service');assert.equal(get().index,0);assert.equal(get().failures.length,0);await assert.rejects(q.enqueue([item]),/已有/);
 offline=false;await q.control('resume');await q.run();assert.equal(get().status,'completed');assert.equal(get().added,1);assert.equal(keys[0],keys[1]);assert.equal(get().results[0].itemId,'NEW');
});
test('authentication and disk errors pause instead of failing every subsequent image',async()=>{
 for(const status of [401,507]){const {q,get}=setup(async()=>{throw localError(status,'error');});await q.enqueue([item,item]);await q.run();assert.equal(get().status,'paused');assert.equal(get().index,0);assert.equal(get().failures.length,0);assert.equal(get().lastError.code,status===401?'AUTH_REQUIRED':'DISK_FULL');}
});
test('cancellation during an offline request remains cancelled, and waiting jobs can pause reconnects',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r);const {q,get}=setup(async()=>{entered();await pending;throw captureError('SERVICE_UNAVAILABLE','offline',{retryable:true});});await q.enqueue([item]);const running=q.run();await started;await q.control('cancel');release();await running;assert.equal(get().status,'cancelled');assert.equal(get().index,0);
 const other=setup(async()=>{throw captureError('SERVICE_UNAVAILABLE','offline',{retryable:true});});await other.q.enqueue([item]);await other.q.run();await other.q.control('pause');assert.equal(other.get().status,'paused');
});
test('Blob tasks and library target survive storage while unsupported schemes and excessive inline data are rejected',async()=>{
 let context;const {q,get}=setup(async(_,c)=>{context=c;return {duplicate:false};});await q.enqueue([{url:'blob:https://example.com/id',tabId:4}],{target:{libraryId:'library-one'}});await q.run();assert.equal(context.target.libraryId,'library-one');assert.equal(get().items[0].tabId,4);await assert.rejects(q.enqueue([{url:'file:///private'}]),/不支持/);await assert.rejects(q.enqueue([{url:'data:image/png;base64,'+'A'.repeat(1024*1024)}]),/超过 1MB/);
});
test('image decoding validates MIME signatures and does not persist base64 as a source URL',()=>{
 assert.equal(decodeImageData(png).ext,'png');assert.throws(()=>decodeImageData('data:image/png;base64,dGV4dA=='),/不一致/);assert.throws(()=>decodeImageData(png,4),/大小限制/);
 const meta=captureMetadata({url:png,website:'https://example.com/page',captureKind:'region-screenshot',acquisition:'inline'});assert.equal(meta.sourceImageURL,null);assert.equal(meta.url,'https://example.com/page');assert.equal(meta.captureKind,'region-screenshot');assert.ok(!JSON.stringify(meta).includes('base64'));
 assert.throws(()=>bookmarkData({url:'javascript:alert(1)'}),/HTTP/);assert.throws(()=>bookmarkData({url:'https://example.com/\r\nInjected=true'}),/无效/);
});
test('capture receipts commit with images and replay original success instead of returning a false duplicate',async()=>{
 const payload={url:'https://example.com/receipt.png',website:'https://example.com/page',name:'receipt',base64:png,acquisition:'page',idempotencyKey:'stage2-receipt-test:0'};
 const first=await(await fetch(base+'/api/capture',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(first.duplicate,false);
 const again=await(await fetch(base+'/api/capture',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(again.duplicate,false);assert.equal(again.item.id,first.item.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,1);
 const receipt=await(await fetch(base+'/api/capture-receipt?key=stage2-receipt-test%3A0',{headers})).json();assert.equal(receipt.found,true);assert.equal(receipt.result.duplicate,false);
 assert.equal((await fetch(base+'/api/capture',{method:'POST',headers,body:JSON.stringify({...payload,name:'different'})})).status,409);
});
test('bookmarks preserve the source, preview image and durable retry receipt without executing a website',async()=>{
 const payload={url:'https://example.com/bookmark',name:'网页收藏',thumbnail:png,tags:['参考'],idempotencyKey:'stage2-bookmark-test:0'};const response=await fetch(base+'/api/bookmark',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.item.ext,'url');assert.equal(saved.item.bookmark,true);assert.equal(saved.item.url,payload.url);const row=catalog.row(saved.item.id);assert.match(fs.readFileSync(catalog.path(row.file),'utf8'),/URL=https:\/\/example.com\/bookmark/);assert.ok(row.thumb);const replay=await(await fetch(base+'/api/bookmark',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(replay.duplicate,false);assert.equal(replay.item.id,saved.item.id);assert.equal(catalog.integrity().healthy,true);
});
test('a failed receipt transaction leaves no acknowledged item and retries can safely commit',async()=>{
 const payload={url:'https://example.com/fault-bookmark',name:'fault',idempotencyKey:'stage2-receipt-fault:0'};const count=db.prepare('SELECT COUNT(*) AS n FROM items').get().n;catalog.fault=p=>{if(p==='before-db-commit')throw Error('receipt-fault');};const failed=await fetch(base+'/api/bookmark',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(failed.status,400);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,count);assert.equal(db.prepare('SELECT key FROM capture_receipts WHERE key=?').get(payload.idempotencyKey),undefined);catalog.fault=()=>{};const saved=await(await fetch(base+'/api/bookmark',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(saved.duplicate,false);assert.equal(catalog.integrity().healthy,true);
});
test('duplicate capture waits for a decision; reuse restores and classifies atomically; keep has durable replay',async()=>{
 const folder=await(await fetch(base+'/api/folders',{method:'POST',headers,body:JSON.stringify({name:'重复归类'})})).json();
 const first=db.prepare('SELECT * FROM items WHERE hash IS NOT NULL LIMIT 1').get(),meta=JSON.parse(first.metadata),bytes=fs.readFileSync(catalog.path(first.file));
 catalog.updateItem(first.id,{isDeleted:true});
 const payload={url:'https://example.com/duplicate.png',base64:'data:image/png;base64,'+bytes.toString('base64'),name:'重复采集',folderId:folder.id,tags:['新标签'],idempotencyKey:'duplicate-decision-test:0',duplicateMode:'ask'};
 const post=p=>fetch(base+'/api/capture',{method:'POST',headers,body:JSON.stringify(p)});
 const ask=await(await post(payload)).json();assert.equal(ask.duplicatePending,true);assert.equal(db.prepare('SELECT key FROM capture_receipts WHERE key=?').get(payload.idempotencyKey),undefined);assert.equal(JSON.parse(catalog.row(first.id).metadata).isDeleted,true);
 const reuse=await(await post({...payload,duplicateMode:'reuse'})).json();assert.equal(reuse.item.id,first.id);assert.equal(reuse.item.isDeleted,false);assert.ok(reuse.item.folders.includes(folder.id));assert.ok(reuse.item.tags.includes('新标签'));assert.equal(reuse.duplicate,true);assert.equal(catalog.row(first.id).hash,first.hash);
 const keep={...payload,idempotencyKey:'duplicate-keep-test:0',duplicateMode:'keep'},added=await(await post(keep)).json(),again=await(await post(keep)).json();assert.equal(added.duplicate,false);assert.notEqual(added.item.id,first.id);assert.equal(again.item.id,added.item.id);assert.equal(catalog.row(added.item.id).hash,first.hash);assert.equal(catalog.integrity().healthy,true);
});
test('collector status separates reported progress from verified local saves and retains actual failure reasons',async()=>{
 const get=async()=>await(await fetch(base+'/api/collector-status',{headers})).json(),before=await get();
 const spoof=await fetch(base+'/api/collector-status',{method:'POST',headers,body:JSON.stringify({id:'fake-save',status:'saved'})});assert.equal(spoof.status,400);
 await fetch(base+'/api/collector-status',{method:'POST',headers,body:JSON.stringify({id:'progress-only',status:'completed',index:1,total:1})});const progress=await get();assert.equal(progress.events.filter(e=>e.status==='saved').length,before.events.filter(e=>e.status==='saved').length);
 const failed=await fetch(base+'/api/capture',{method:'POST',headers,body:JSON.stringify({base64:png,name:'错误分类采集',folderId:'does-not-exist',duplicateMode:'keep'})});assert.equal(failed.status,400);const status=await get();assert.equal(status.events[0].status,'failed');assert.match(status.events[0].message,/文件夹不存在/);assert.equal(status.events[0].path,root);assert.equal(status.libraryId,catalog.libraryId);
});
test('replaying a receipt for a deleted or altered original cannot acknowledge a visible successful capture',async()=>{
 const payload={url:'https://example.com/deleted-receipt',name:'回执可见性',idempotencyKey:'receipt-visibility-test:0'},r=await(await fetch(base+'/api/bookmark',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(r.verified,true);assert.equal(r.destination.path,root);catalog.updateItem(r.item.id,{isDeleted:true});let receipt=await fetch(base+'/api/capture-receipt?key='+encodeURIComponent(payload.idempotencyKey),{headers});assert.equal(receipt.status,409);assert.match((await receipt.json()).error,/回收站/);catalog.updateItem(r.item.id,{isDeleted:false});const file=catalog.path(catalog.row(r.item.id).file),original=fs.readFileSync(file);fs.appendFileSync(file,'changed');receipt=await fetch(base+'/api/capture-receipt?key='+encodeURIComponent(payload.idempotencyKey),{headers});assert.equal(receipt.status,409);fs.writeFileSync(file,original);
});
after(async()=>{await new Promise(r=>server.close(r));catalog.close();if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('assetnest-stage2-'))fs.rmSync(root,{recursive:true,force:true});});
