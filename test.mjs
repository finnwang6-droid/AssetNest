import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {zipSync,unzipSync,strToU8} from 'fflate';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-test-'));
process.env.ASSETNEST_DATA=dir;
process.env.ASSETNEST_PORT='41601';
const {importPack,exportPack,db,server,catalog}=await import('./server.mjs');
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=','base64');
const meta={id:'TEST001',name:'测试素材',ext:'png',size:image.length,width:1,height:1,tags:['参考','配色'],folders:['FOLDER001'],url:'https://example.com/source',annotation:'保存原始注释',palettes:[{color:[12,34,56],ratio:100}],modificationTime:1700000000000};
const folder={id:'FOLDER001',name:'测试分类',description:'说明',children:[{id:'CHILD001',name:'子文件夹',children:[]}],tags:['层级']};
const pack=zipSync({'pack.json':strToU8(JSON.stringify({images:[meta],folder})),['TEST001.info/测试素材.png']:image,['TEST001.info/metadata.json']:strToU8(JSON.stringify(meta)),['TEST001.info/测试素材_thumbnail.png']:image});
test('Eagle pack preserves original bytes, thumbnails, metadata and folder hierarchy',()=>{
 assert.equal(importPack(pack).imported,1);
 const files=unzipSync(exportPack()),p=JSON.parse(Buffer.from(files['pack.json']));
 assert.deepEqual(Buffer.from(files['TEST001.info/测试素材.png']),image);
 assert.deepEqual(Buffer.from(files['TEST001.info/测试素材_thumbnail.png']),image);
 for(const [k,v]of Object.entries(meta))assert.deepEqual(p.images[0][k],v,k);
 assert.equal(p.folder.name,folder.name);assert.equal(p.folder.children[0].name,'子文件夹');
 assert.equal(importPack(pack).duplicates,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,1);
});
test('invalid archive paths and missing originals are rejected before catalog changes',()=>{
 assert.throws(()=>importPack(zipSync({'../escape.txt':strToU8('x'),'pack.json':strToU8('{"images":[]}')})),/无效路径/);
 assert.throws(()=>importPack(zipSync({'pack.json':strToU8(JSON.stringify({images:[{...meta,id:'MISSING'}]}))})),/缺少原文件/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,1);
});
test('same ID with different bytes is stored under a fresh ID',()=>{
 const other=Buffer.concat([image,Buffer.from('different')]);const m={...meta,name:'另一个素材',size:other.length};
 assert.equal(importPack(zipSync({'pack.json':strToU8(JSON.stringify({images:[m]})),['TEST001.info/另一个素材.png']:other})).imported,1);
 const rows=db.prepare('SELECT id,hash FROM items').all();assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
});
test('HTTP API rejects invalid keys and foreign origins; supports editing and soft deletion',async()=>{
 await new Promise(resolve=>server.listen(41601,'127.0.0.1',resolve));
 const root='http://127.0.0.1:41601';
 try{
 assert.equal((await fetch(root+'/api/items')).status,401);
 assert.equal((await fetch(root+'/api/bootstrap',{headers:{Origin:'https://untrusted.example'}})).status,403);
 const bootstrap=await(await fetch(root+'/api/bootstrap')).json();const headers={'X-Assetnest-Key':bootstrap.key,'Content-Type':'application/json'};
 const extension=await fetch(root+'/api/extension-download',{headers});assert.equal(extension.status,200);const extensionFiles=unzipSync(new Uint8Array(await extension.arrayBuffer()));assert.ok(extensionFiles['assetnest-extension/queue.js']);assert.ok(extensionFiles['assetnest-extension/capture-worker.js']);assert.ok(extensionFiles['assetnest-extension/scanner.js']);assert.equal(JSON.parse(Buffer.from(extensionFiles['assetnest-extension/manifest.json'])).version,'0.5.5');
 assert.equal((await fetch(root+'/api/items',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
 let response=await fetch(root+'/api/items/TEST001',{method:'PATCH',headers,body:JSON.stringify({name:'新名称',tags:['新标签'],isDeleted:true})});assert.equal(response.status,200);
 const items=(await(await fetch(root+'/api/items',{headers})).json()).items;const i=items.find(i=>i.id==='TEST001');assert.equal(i.isDeleted,true);assert.deepEqual(i.tags,['新标签']);
 assert.equal((await fetch(root+'/media/TEST001/original')).status,200);
 const exported=unzipSync(exportPack(['TEST001']));assert.ok(exported['TEST001.info/新名称.png']);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
after(()=>{catalog.close();fs.rmSync(dir,{recursive:true,force:true});});
