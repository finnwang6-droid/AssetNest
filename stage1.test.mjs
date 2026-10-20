import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {Catalog,digest} from './storage.mjs';
import {preparePack,commitPack,exportPack} from './eagle-pack.mjs';
import {createBackup,verifyBackup,restoreBackup} from './backup.mjs';
import {rebuildCatalog} from './rebuild.mjs';

const roots=[];function temp(){const r=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-stage1-'));roots.push(r);return r;}
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=','base64');
const base={id:'ONE',name:'长名称😀:CON'+ '中'.repeat(140),ext:'PNG',size:image.length,tags:['非空'],folders:['ROOT'],annotation:'注释',modificationTime:1700000000000,unknownItem:{a:[1,'x']}};
const folder={id:'ROOT',name:'测试',children:[{id:'CHILD',name:'子目录',children:[]}],unknownFolder:{x:1}};
function fixture({images=[base],disk=null,root={folder,unknownRoot:{version:9,values:['a','b']}}}={}){
 const files={'pack.json':strToU8(JSON.stringify({...root,images}))};
 for(const m of images){files[`${m.id}.info/${m.name}.${m.ext}`]=image;files[`${m.id}.info/metadata.json`]=strToU8(JSON.stringify(disk||m));}
 return zipSync(files,{level:0});
}
function importInto(c,bytes){return commitPack(c,preparePack(c,bytes));}
function readPack(bytes){return JSON.parse(Buffer.from(unzipSync(bytes)['pack.json']));}

test('preserves independent root/item/folder/disk fields and long Windows-invalid display names',()=>{
 const c=new Catalog(temp());try{const disk={...base,unknownDisk:[3,4],annotation:'目录中的不同注释'};const report=importInto(c,fixture({disk}));assert.equal(report.imported,1);assert.ok(report.warnings.some(w=>w.kind==='metadata-fields-differ-preserved'));
 const exported=exportPack(c),pack=readPack(exported),files=unzipSync(exported);assert.deepEqual(pack,{folder,unknownRoot:{version:9,values:['a','b']},images:[base]});assert.deepEqual(JSON.parse(Buffer.from(files[`${base.id}.info/metadata.json`])),disk);assert.deepEqual(Buffer.from(files[`${base.id}.info/${base.name}.${base.ext}`]),image);assert.ok(!JSON.stringify(pack).includes('parentId'));assert.equal(c.integrity().healthy,true);
 }finally{c.close();}
});
test('preserves absent folder/metadata records and supports empty packs',()=>{
 const c=new Catalog(temp());try{const m={...base,id:'NOFOLDER',folders:[]};const files={'pack.json':strToU8(JSON.stringify({images:[m],custom:1})),[`${m.id}.info/${m.name}.${m.ext}`]:image};importInto(c,zipSync(files));const output=unzipSync(exportPack(c));assert.equal(readPack(exportPack(c)).folder,undefined);assert.equal(output['NOFOLDER.info/metadata.json'],undefined);const empty=preparePack(c,zipSync({'pack.json':strToU8('{"images":[],"customEmpty":true}')}));assert.equal(empty.report.total,0);
 }finally{c.close();}
});
test('same ID metadata conflicts preserve existing edits in a new copy; same content distinct IDs remain distinct',()=>{
 const c=new Catalog(temp());try{const original=fixture();importInto(c,original);assert.equal(importInto(c,original).duplicates,1);
 c.updateItem('ONE',{annotation:'本地编辑'});const r=importInto(c,original);assert.equal(r.conflicts,1);assert.notEqual(r.entries[0].id,'ONE');assert.equal(JSON.parse(c.row('ONE').metadata).annotation,'本地编辑');
 const separate=importInto(c,fixture({images:[{...base,id:'ANOTHER'}]}));assert.equal(separate.imported,1);assert.equal(separate.contentDuplicates,1);
 assert.equal(c.integrity().healthy,true);
 }finally{c.close();}
});
test('different root metadata is preserved as a separate source context instead of being silently deduplicated',()=>{
 const c=new Catalog(temp());try{importInto(c,fixture());const report=importInto(c,fixture({root:{folder,unknownRoot:{version:10}}}));assert.equal(report.conflicts,1);assert.equal(report.entries[0].action,'pack-context-conflict-copy');const exported=readPack(exportPack(c,[report.entries[0].id]));assert.deepEqual(exported.unknownRoot,{version:10});assert.throws(()=>exportPack(c),/多个来源/);}finally{c.close();}
});
test('folder ID conflict remaps hierarchy and references without changing existing folder',()=>{
 const c=new Catalog(temp());try{importInto(c,fixture());const f={...folder,name:'另一个根'};const p=preparePack(c,fixture({images:[{...base,id:'TWO',folders:['CHILD']}],root:{folder:f}}));assert.equal(p.report.folderConflicts,2);commitPack(c,p);const m=JSON.parse(c.row('TWO').metadata);assert.notEqual(m.folders[0],'CHILD');assert.equal(JSON.parse(c.folders().find(f=>f.id==='ROOT').metadata).name,'测试');assert.equal(c.integrity().healthy,true);
 }finally{c.close();}
});
test('preflight rejects corrupt archives, duplicate entries, invalid references and metadata conflicts without writes',()=>{
 const c=new Catalog(temp());try{
 const original=fixture(),bad=Buffer.from(original);bad[70]^=1;assert.throws(()=>preparePack(c,bad));
 assert.throws(()=>preparePack(c,fixture({images:[{...base,folders:['MISSING']}]})),/不存在的文件夹/);
 assert.throws(()=>preparePack(c,fixture({disk:{...base,id:'WRONG'}})),/标识不一致/);
 assert.throws(()=>preparePack(c,fixture({images:[base,base]})),/ID 重复/);
 const dup=Buffer.from(zipSync({'one.json':strToU8('{}'),'two.json':strToU8('{}')}));for(let i=0;i<dup.length-8;i++)if(dup.subarray(i,i+8).toString()==='two.json')dup.write('one.json',i);assert.throws(()=>preparePack(c,dup),/重复条目/);
 const extra=unzipSync(original);extra['unknown-resource.bin']=image;assert.throws(()=>preparePack(c,zipSync(extra)),/附加文件/);
 assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,0);assert.equal(c.folders().length,0);assert.deepEqual(fs.readdirSync(c.images),[]);
 }finally{c.close();}
});
test('insufficient space is rejected before staging and a changed catalog invalidates preview',()=>{
 const c=new Catalog(temp());try{c.space=()=>({bavail:0,bsize:4096});assert.throws(()=>preparePack(c,fixture()),/空间不足/);assert.deepEqual(fs.readdirSync(c.transactions),[]);c.space=()=>fs.statfsSync(c.root);const plan=preparePack(c,fixture());c.commit({folders:[{id:'OTHER',raw:{id:'OTHER',name:'其他',children:[]},parentId:null}]});assert.throws(()=>commitPack(c,plan),/已变化/);assert.equal(c.row('ONE'),undefined);
 }finally{c.close();}
});
test('in-process failures at staging, journal, publish and SQL commit roll back entire import',()=>{
 for(const point of ['after-stage-item','after-journal','after-backup','after-publish-item','before-db-commit']){
  const c=new Catalog(temp(),{fault:p=>{if(p===point)throw Error('injected '+point);}});try{assert.throws(()=>importInto(c,fixture()),/injected/);assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,0,point);assert.equal(c.folders().length,0,point);assert.deepEqual(fs.readdirSync(c.images),[],point);assert.equal(c.integrity().healthy,true);}finally{c.close();}
 }
});
test('metadata edits and all JSON/file/index state roll back together on failure',()=>{
 const c=new Catalog(temp());try{importInto(c,fixture());const before=fs.readFileSync(path.join(c.images,'ONE.info/metadata.json'),'utf8');c.fault=p=>{if(p==='before-db-commit')throw Error('disk-write-failure');};assert.throws(()=>c.updateItem('ONE',{name:'新名称',annotation:'新内容'}),/disk-write-failure/);assert.equal(c.row('ONE').metadata,JSON.stringify(base));assert.equal(fs.readFileSync(path.join(c.images,'ONE.info/metadata.json'),'utf8'),before);assert.equal(c.integrity().healthy,true);}finally{c.close();}
});
test('real process exits recover before commit and retain fully committed imports',()=>{
 const storageURL=new URL('./storage.mjs',import.meta.url).href,packURL=new URL('./eagle-pack.mjs',import.meta.url).href;
 for(const point of ['after-stage-item','after-journal','after-publish-item','before-db-commit','after-db-commit']){
  const root=temp(),input=path.join(root,'input.eaglepack');fs.writeFileSync(input,fixture());
  const code=`import fs from 'node:fs';import {Catalog} from ${JSON.stringify(storageURL)};import {preparePack,commitPack} from ${JSON.stringify(packURL)};const c=new Catalog(${JSON.stringify(root)},{fault:p=>{if(p===${JSON.stringify(point)})process.exit(73);}});commitPack(c,preparePack(c,fs.readFileSync(${JSON.stringify(input)})));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(child.status,73,child.stderr);
  const recovered=new Catalog(root);try{assert.equal(recovered.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,point==='after-db-commit'?1:0,point);assert.equal(recovered.integrity().healthy,true,point);assert.deepEqual(fs.readdirSync(recovered.transactions),[]);}finally{recovered.close();}
 }
});
test('live writer lock prevents a second process and legacy records migrate without rewriting images',()=>{
 const root=temp(),c=new Catalog(root);try{assert.throws(()=>new Catalog(root),/正在使用/);importInto(c,fixture());const before=fs.readFileSync(c.path(c.row('ONE').file));assert.deepEqual(before,image);}finally{c.close();}
 const again=new Catalog(root);try{assert.equal(again.integrity().healthy,true);}finally{again.close();}
});
test('0.2 legacy schema migrates raw metadata and hierarchy without rewriting existing content',()=>{
 const root=temp(),dir=path.join(root,'images/OLD.info');fs.mkdirSync(dir,{recursive:true});const m={...base,id:'OLD',name:'old',ext:'png'};fs.writeFileSync(path.join(dir,'old.png'),image);fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify(m));const old=new DatabaseSync(path.join(root,'catalog.sqlite'));old.exec('CREATE TABLE items(id TEXT PRIMARY KEY,metadata TEXT,file TEXT,thumb TEXT,hash TEXT); CREATE TABLE folders(id TEXT PRIMARY KEY,metadata TEXT);');old.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run('OLD',JSON.stringify(m),'OLD.info/old.png',null,digest(image));
 old.prepare('INSERT INTO folders VALUES(?,?)').run('ROOT',JSON.stringify({...folder,parentId:null}));old.close();const c=new Catalog(root);try{assert.equal(c.integrity().healthy,true);assert.deepEqual(Buffer.from(fs.readFileSync(c.path(c.row('OLD').file))),image);assert.deepEqual(JSON.parse(c.source('OLD').file_metadata),m);assert.equal(JSON.parse(c.folders()[0].metadata).parentId,undefined);}finally{c.close();}
});
test('verified backup restores to a new library and refuses overwriting existing user data',()=>{
 const c=new Catalog(temp());try{importInto(c,fixture());const backup=createBackup(c);assert.equal(verifyBackup(backup.directory).items,1);const target=path.join(temp(),'restored');restoreBackup(backup.directory,target);const restored=new Catalog(target);try{assert.equal(restored.integrity().healthy,true);assert.deepEqual(readPack(exportPack(restored)),readPack(exportPack(c)));}finally{restored.close();}assert.throws(()=>restoreBackup(backup.directory,target),/不覆盖/);const originalPath=path.join(backup.directory,'images',c.row('ONE').file);fs.appendFileSync(originalPath,'tampered');assert.throws(()=>verifyBackup(backup.directory),/哈希/);}finally{c.close();}
});
test('index rebuild preserves raw pack information when readable and reports missing semantics after index corruption',()=>{
 const root=temp(),c=new Catalog(root);importInto(c,fixture({root:{folder:{...folder,parentId:'opaque-source-field'},unknownRoot:{version:9}}}));const before=readPack(exportPack(c));c.close();
 const rebuilt=path.join(temp(),'readable');assert.equal(rebuildCatalog(root,rebuilt).healthy,true);const checked=new Catalog(rebuilt);try{assert.deepEqual(readPack(exportPack(checked)),before);}finally{checked.close();}
 fs.writeFileSync(path.join(root,'catalog.sqlite'),'broken database');const recovered=path.join(temp(),'recovered');const result=rebuildCatalog(root,recovered);assert.equal(result.items,1);assert.ok(result.warnings.some(w=>w.includes('根字段')));const check=new Catalog(recovered);try{assert.equal(check.integrity().healthy,true);assert.deepEqual(fs.readFileSync(check.path(check.row('ONE').file)),image);assert.equal(JSON.parse(check.folders().find(f=>f.id==='ROOT').metadata).name,folder.name);assert.equal(check.folders().find(f=>f.id==='CHILD').parent_id,'ROOT');}finally{check.close();}
 assert.throws(()=>rebuildCatalog(root,recovered),/不覆盖/);
});
test('failed replacement followed by a real process exit restores previous metadata',()=>{
 const root=temp(),c=new Catalog(root);importInto(c,fixture());c.close();const storageURL=new URL('./storage.mjs',import.meta.url).href;
 const code=`import {Catalog} from ${JSON.stringify(storageURL)};const c=new Catalog(${JSON.stringify(root)},{fault:p=>{if(p==='after-backup')process.exit(74);}});c.updateItem('ONE',{annotation:'should rollback'});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(child.status,74,child.stderr);const recovered=new Catalog(root);try{assert.equal(JSON.parse(recovered.row('ONE').metadata).annotation,base.annotation);assert.equal(recovered.integrity().healthy,true);}finally{recovered.close();}
});
test('two-item imports are all-or-nothing when the second item fails publication',()=>{
 let published=0;const c=new Catalog(temp(),{fault:p=>{if(p==='after-publish-item'&&++published===2)throw Error('second-item-failure');}});try{assert.throws(()=>importInto(c,fixture({images:[base,{...base,id:'TWO'}]})),/second-item/);assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,0);assert.equal(c.folders().length,0);assert.deepEqual(fs.readdirSync(c.images),[]);}finally{c.close();}
});
test('selected exports prune unrelated subfolders without adding derived metadata',()=>{
 const c=new Catalog(temp());try{const root={...folder,children:[...folder.children,{id:'OTHER',name:'另一个子目录',children:[]}]};importInto(c,fixture({images:[{...base,folders:['CHILD']},{...base,id:'TWO',folders:['OTHER']}],root:{folder:root,unknownRoot:'keep'}}));const selected=readPack(exportPack(c,['ONE']));assert.equal(selected.images.length,1);assert.equal(selected.folder.children.length,1);assert.equal(selected.folder.children[0].id,'CHILD');assert.equal(selected.unknownRoot,'keep');assert.ok(!JSON.stringify(selected).includes('parentId'));}finally{c.close();}
});
test('export includes newly assigned folders and refuses silently changed originals or metadata',()=>{
 const c=new Catalog(temp());try{importInto(c,fixture());c.commit({folders:[{id:'NEW',raw:{id:'NEW',name:'新增',children:[]},parentId:'ROOT'}]});c.updateItem('ONE',{folders:['NEW']});const p=readPack(exportPack(c));assert.equal(p.images[0].folders[0],'NEW');assert.ok(p.folder.children.some(f=>f.id==='NEW'));const file=c.path(c.row('ONE').file),original=fs.readFileSync(file);fs.appendFileSync(file,'changed');assert.throws(()=>exportPack(c),/原图完整性/);fs.writeFileSync(file,original);fs.writeFileSync(path.join(c.images,'ONE.info/metadata.json'),'{}');assert.throws(()=>exportPack(c),/元数据与索引/);}finally{c.close();}
});
after(()=>{for(const root of roots)if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('assetnest-stage1-'))fs.rmSync(root,{recursive:true,force:true});});
