import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Catalog,digest} from './storage.mjs';
import {OrganizationJobs} from './organization-jobs.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-organization-'));
function seed(c,id='ONE',deleted=false){const bytes=Buffer.from('original '+id),metadata=JSON.stringify({id,name:id,ext:'txt',tags:['old','shared'],folders:['A'],star:1,isDeleted:deleted,annotation:'before',custom:{preserve:42}});c.commit({folders:[{id:'A',raw:{id:'A',name:'原分类'},parentId:null},{id:'B',raw:{id:'B',name:'新分类'},parentId:null}],items:[{row:{id,metadata,file:id+'.info/'+id+'.txt',thumb:null,hash:digest(bytes)},source:{file_metadata:JSON.stringify({...JSON.parse(metadata),diskOnly:7}),pack_id:null},files:{[id+'.txt']:bytes,'attachment.txt':Buffer.from('attachment')}}]});}
function state(c){return c.db.prepare('SELECT * FROM items ORDER BY id').all().map(row=>({row,source:c.source(row.id),bytes:digest(fs.readFileSync(c.path(row.file))),attachment:digest(fs.readFileSync(path.join(c.images,row.id+'.info/attachment.txt')))}));}
const edit={kind:'batch',ids:['ONE','TWO'],rename:{template:'作品-{n}-{name}',start:10},addTags:['new'],removeTags:['old'],folderMode:'replace',folders:['B'],patch:{star:5,annotation:'after'}};

test('preview is read only; confirmation and restart-safe undo preserve originals, attachments and unknown metadata',()=>{
 const dir=path.join(temp,'roundtrip');let c=new Catalog(dir);try{seed(c);seed(c,'TWO');const original=state(c),j=new OrganizationJobs(c),p=j.preview(edit);assert.equal(p.changed,2);assert.equal(p.changes[0].after.name,'作品-10-ONE');assert.deepEqual(state(c),original);assert.equal(j.summary(),null);
 const applied=j.apply(p.token);assert.equal(applied.updated,2);assert.equal(JSON.parse(c.row('ONE').metadata).star,5);assert.equal(j.apply(p.token).replayed,true);assert.equal(j.summary().count,2);
 c.close();c=new Catalog(dir);const restarted=new OrganizationJobs(c);assert.equal(restarted.summary().id,p.token);assert.equal(restarted.undo(p.token).restored,2);assert.deepEqual(state(c),original);assert.equal(restarted.summary(),null);assert.equal(c.integrity().healthy,true);
 }finally{c.close();}
});

test('stale metadata, removed folders, expired previews and invalid Windows names reject the entire batch',()=>{
 const c=new Catalog(path.join(temp,'stale'));try{seed(c);seed(c,'TWO');let now=0;const j=new OrganizationJobs(c,{now:()=>now});const p=j.preview(edit);c.updateItem('TWO',{annotation:'later'});const after=state(c);assert.throws(()=>j.apply(p.token),/预览后已变化/);assert.deepEqual(state(c),after);
 const expiry=j.preview(edit);now=300001;assert.throws(()=>j.apply(expiry.token),/过期/);assert.throws(()=>j.preview({...edit,rename:{template:'CON'}}),/保留名称/);
 const folders=j.preview(edit);c.commit({deleteFolders:['B']});assert.throws(()=>j.apply(folders.token),/文件夹已变化/);assert.deepEqual(state(c),after);
 }finally{c.close();}
});

test('undo refuses later edits and missing or modified originals without overwriting any item',()=>{
 const c=new Catalog(path.join(temp,'undo-guards'));try{seed(c);seed(c,'TWO');const j=new OrganizationJobs(c),p=j.preview(edit);j.apply(p.token);c.updateItem('TWO',{annotation:'keep later edit'});const after=state(c);assert.throws(()=>j.undo(p.token),/后来|已被修改/);assert.deepEqual(state(c),after);
 const next=j.preview({...edit,patch:{star:2}});j.apply(next.token);const row=c.row('ONE'),original=fs.readFileSync(c.path(row.file));fs.writeFileSync(c.path(row.file),'changed bytes');assert.throws(()=>j.undo(next.token),/原文件缺失或内容已变化/);fs.writeFileSync(c.path(row.file),original);fs.renameSync(c.path(row.file),c.path(row.file)+'.held');assert.throws(()=>j.undo(next.token),/原文件缺失/);fs.renameSync(c.path(row.file)+'.held',c.path(row.file));assert.equal(j.summary().id,next.token);
 }finally{c.close();}
});

test('tag preview counts recycled items, detects new affected items, merges without duplicates and is reversible',()=>{
 const c=new Catalog(path.join(temp,'tags'));try{seed(c);seed(c,'TWO',true);const j=new OrganizationJobs(c),p=j.preview({kind:'tags',from:'old',to:'shared'});assert.equal(p.includesTrash,true);assert.equal(p.changed,2);seed(c,'THREE');assert.throws(()=>j.apply(p.token),/影响范围已变化/);
 // Legacy metadata names need not be rewritten for a tag-only operation.
c.db.prepare("UPDATE items SET metadata=json_set(metadata,'$.name','CON') WHERE id='ONE'").run();const before=state(c),next=j.preview({kind:'tags',from:'old',to:'shared'});j.apply(next.token);assert.deepEqual(JSON.parse(c.row('TWO').metadata).tags,['shared']);assert.equal(JSON.parse(c.row('TWO').metadata).isDeleted,true);j.undo(next.token);assert.deepEqual(state(c),before);
 }finally{c.close();}
});

test('failed publication rolls back the batch and its undo record in the same transaction',()=>{
 const c=new Catalog(path.join(temp,'atomic'));try{seed(c);seed(c,'TWO');const j=new OrganizationJobs(c),first=j.preview(edit);j.apply(first.token);const after=state(c),next=j.preview({...edit,patch:{star:3}});c.fault=p=>{if(p==='before-db-commit')throw Error('injected failure');};assert.throws(()=>j.apply(next.token),/injected failure/);assert.deepEqual(state(c),after);assert.equal(j.summary().id,first.token);assert.throws(()=>j.undo(first.token),/injected failure/);assert.deepEqual(state(c),after);assert.equal(j.summary().id,first.token);c.fault=()=>{};j.undo(first.token);assert.equal(j.summary(),null);
 }finally{c.close();}
});

test('no-op preview preserves previous undo; undo rejects removed original folders',()=>{
 const c=new Catalog(path.join(temp,'noop'));try{seed(c);const j=new OrganizationJobs(c),p=j.preview({kind:'batch',ids:['ONE'],folderMode:'replace',folders:['B']});j.apply(p.token);const noop=j.preview({kind:'batch',ids:['ONE'],patch:{}});assert.equal(noop.changed,0);assert.equal(j.apply(noop.token).updated,0);assert.equal(j.summary().id,p.token);c.commit({deleteFolders:['A']});assert.throws(()=>j.undo(p.token),/原文件夹已删除/);
 }finally{c.close();}
});

test('permanent deletion clears an affected undo record in the same transaction',()=>{
 const c=new Catalog(path.join(temp,'purge-history'));try{seed(c,'ONE',true);const j=new OrganizationJobs(c),p=j.preview({kind:'batch',ids:['ONE'],patch:{star:4}});j.apply(p.token);assert.ok(j.summary());c.commit({deleteItems:['ONE']});assert.equal(j.summary(),null);assert.equal(c.row('ONE'),undefined);}finally{c.close();}
});

test('real process interruption recovers batch changes and undo history together before and after commit',()=>{
 for(const action of ['apply','undo'])for(const point of ['before-db-commit','after-db-commit']){
  const dir=path.join(temp,action+'-'+point);let c=new Catalog(dir);seed(c);const original=state(c);const j=new OrganizationJobs(c),p=j.preview({kind:'batch',ids:['ONE'],patch:{star:5}});if(action==='undo')j.apply(p.token);c.close();
  const code=`import {Catalog} from ${JSON.stringify(pathToFileURL(path.resolve('storage.mjs')).href)};import {OrganizationJobs} from ${JSON.stringify(pathToFileURL(path.resolve('organization-jobs.mjs')).href)};const c=new Catalog(process.argv[1]),j=new OrganizationJobs(c);c.fault=p=>{if(p===process.argv[2])process.exit(71)};if(process.argv[3]==='undo')j.undo(j.summary().id);else j.apply(j.preview({kind:'batch',ids:['ONE'],patch:{star:5}}).token);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,dir,point,action],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(child.status,71,child.stderr);c=new Catalog(dir);try{const history=new OrganizationJobs(c),applied=action==='apply'?point==='after-db-commit':point==='before-db-commit';assert.equal(!!history.summary(),applied);if(applied){assert.equal(JSON.parse(c.row('ONE').metadata).star,5);history.undo(history.summary().id);}assert.deepEqual(state(c),original);assert.equal(c.integrity().healthy,true);}finally{c.close();}
 }
});

process.env.ASSETNEST_DATA=path.join(temp,'api');process.env.ASSETNEST_PORT='41772';const service=await import('./server.mjs');const base='http://127.0.0.1:41772';let headers;
before(async()=>{await new Promise(r=>service.server.listen(41772,'127.0.0.1',r));const b=await(await fetch(base+'/api/bootstrap')).json();headers={'Content-Type':'application/json','X-Assetnest-Key':b.key,'X-Assetnest-Library':b.libraryId};seed(service.catalog);});
const post=(route,p,extra={})=>fetch(base+'/api/organization/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(p)});
test('organization API requires auth, local origin and matching library, then previews, applies and undoes',async()=>{
 const payload={kind:'batch',ids:['ONE'],patch:{star:4}};assert.equal((await post('preview',payload,{'X-Assetnest-Key':'invalid'})).status,401);assert.equal((await post('preview',payload,{Origin:'chrome-extension://example'})).status,403);assert.equal((await post('preview',payload,{'X-Assetnest-Library':'stale'})).status,409);assert.equal((await post('preview',payload,{'X-Assetnest-Library':''})).status,409);
 const p=await(await post('preview',payload)).json();assert.equal(JSON.parse(service.catalog.row('ONE').metadata).star,1);assert.equal((await post('apply',{token:p.token})).status,200);assert.equal(JSON.parse(service.catalog.row('ONE').metadata).star,4);assert.equal((await post('undo',{id:p.token})).status,200);assert.equal(JSON.parse(service.catalog.row('ONE').metadata).star,1);
});
after(async()=>{await new Promise(r=>service.server.close(r));service.catalog.close();if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('assetnest-organization-'))fs.rmSync(temp,{recursive:true,force:true});});
