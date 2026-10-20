import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CaptureQueue} from './extension/queue.js';
function setup(capture){let stored;return {queue:new CaptureQueue({read:async()=>structuredClone(stored),write:async j=>{stored=structuredClone(j);},capture}),get:()=>structuredClone(stored)};}
const item=n=>({url:'https://example.com/'+n+'.jpg',name:'Image '+n});
test('background queue persists success, duplicate and failures and retries only failures',async()=>{
 let failure=true;const {queue,get}=setup(async i=>{if(i.name==='Image 3'&&failure)throw Error('下载失败');return {duplicate:i.name==='Image 2'};});
 await queue.enqueue([item(1),item(2),item(3)]);await queue.run();
 assert.equal(get().status,'completed');assert.equal(get().added,1);assert.equal(get().duplicates,1);assert.equal(get().failures.length,1);
 failure=false;await queue.retry();await queue.run();assert.equal(get().items.length,1);assert.equal(get().added,1);assert.equal(get().failures.length,0);
});
test('pause and cancel during an in-flight request are preserved',async()=>{
 let release;let entered;const started=new Promise(resolve=>entered=resolve);const pending=new Promise(resolve=>release=resolve);
 const {queue,get}=setup(async()=>{entered();await pending;return {duplicate:false};});await queue.enqueue([item(1),item(2)]);const run=queue.run();await started;await queue.control('pause');release();await run;
 assert.equal(get().status,'paused');assert.equal(get().index,1);
 await queue.control('cancel');assert.equal(get().status,'cancelled');await queue.run();assert.equal(get().index,1);
});
test('a new worker instance resumes persisted pending entries',async()=>{
 let stored={id:'persisted',status:'running',items:[item(1),item(2)],index:1,added:1,duplicates:0,failures:[]};let calls=0;
 const q=new CaptureQueue({read:async()=>structuredClone(stored),write:async j=>{stored=structuredClone(j);},capture:async()=>{calls++;return {duplicate:false};}});
 await q.run();assert.equal(calls,1);assert.equal(stored.added,2);assert.equal(stored.status,'completed');
});
test('concurrent enqueues append to a running job without replacing its receipt identity',async()=>{
 const {queue,get}=setup(async()=>({duplicate:false}));const results=await Promise.allSettled([queue.enqueue([item(1)]),queue.enqueue([item(2)])]);assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(get().items[0].name,'Image 1');assert.equal(get().items[1].name,'Image 2');await queue.run();assert.equal(get().added,2);
 await assert.rejects(queue.enqueue(Array.from({length:101},(_,n)=>item(n))),/1～100/);
});
test('duplicate decisions persist without advancing and keep choice replays the same receipt',async()=>{
 const keys=[];const {queue,get}=setup(async(i,c)=>{keys.push(c.key);return i.duplicateMode?{duplicate:i.duplicateMode==='reuse',item:{id:'saved'}}:{duplicatePending:true,duplicate:true,item:{id:'existing',name:'已有图片'}};});
 await queue.enqueue([item(1)]);await queue.run();assert.equal(get().status,'awaiting-duplicate');assert.equal(get().index,0);assert.equal(get().duplicates,0);await assert.rejects(queue.enqueue([item(2)]),/已有/);await queue.control('keep');await queue.run();assert.equal(get().status,'completed');assert.equal(get().added,1);assert.equal(keys[0],keys[1]);
});
test('notification failures never turn a committed capture into a failed queue',async()=>{
 let stored;const q=new CaptureQueue({read:async()=>structuredClone(stored),write:async j=>stored=structuredClone(j),capture:async()=>({item:{id:'saved'},duplicate:false}),onChange:async()=>{throw Error('tab closed');}});await q.enqueue([item(1)]);await q.run();assert.equal(stored.status,'completed');assert.equal(stored.added,1);
});
test('retarget preserves pending images and prior results but assigns new receipts and validates folders',async()=>{
 let stored={id:'old-task',status:'paused',target:{server:'http://127.0.0.1:41600',libraryId:'old'},items:[item(0),{...item(1),folderId:'missing'},{...item(2),folderId:'valid'}],index:1,added:1,duplicates:0,failures:[],results:[{itemId:'already-saved'}],lastError:{code:'LIBRARY_CHANGED'}};const seen=[];
 const q=new CaptureQueue({read:async()=>structuredClone(stored),write:async j=>stored=structuredClone(j),capture:async(i,c)=>{seen.push({i,c});return {duplicate:false};}});const target={server:'http://127.0.0.1:41600',libraryId:'current'};
 await q.retarget('old-task',target,['valid']);assert.notEqual(stored.id,'old-task');assert.equal(stored.previousJobId,'old-task');assert.equal(stored.items.length,2);assert.equal(stored.items[0].folderId,'');assert.equal(stored.items[1].folderId,'valid');assert.equal(stored.previousResults[0].itemId,'already-saved');await q.run();assert.equal(stored.added,2);assert.equal(seen[0].c.target.libraryId,'current');assert.notEqual(seen[0].c.key,'old-task:0');await assert.rejects(q.retarget('old-task',target),/状态已变化/);
});
