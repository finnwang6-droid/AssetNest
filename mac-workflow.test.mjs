import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {Libraries} from './libraries.mjs';
import {jobFeedback} from './extension/feedback.js';
test('successful capture notification opens the desktop; unresolved work keeps queue controls',()=>{
 const job={status:'completed',added:1,duplicates:0,failures:[]};assert.equal(jobFeedback(job).action,'open-desktop');assert.match(jobFeedback(job).detail,/点击打开拾素材/);assert.equal(jobFeedback({...job,failures:[{}]}).action,'open-results');assert.notEqual(jobFeedback({status:'awaiting-duplicate'}).action,'open-desktop');
});
test('create in a populated disk creates a named child library, switches and persists without overwriting',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'assetnest-new-library-')),disk=path.join(root,'D');fs.mkdirSync(disk);fs.writeFileSync(path.join(disk,'keep.txt'),'keep');let libs=new Libraries(path.join(root,'initial'));
 try{const old=libs.current;libs.createIn({parent:disk,name:'日常'});assert.equal(libs.current,path.join(disk,'日常.library'));assert.equal(libs.locationConfirmed,true);assert.ok(fs.existsSync(path.join(libs.current,'catalog.sqlite')));assert.ok(fs.existsSync(path.join(old,'catalog.sqlite')));assert.equal(fs.readFileSync(path.join(disk,'keep.txt'),'utf8'),'keep');assert.throws(()=>libs.createIn({parent:disk,name:'日常'}),/同名/);for(const name of ['../outside','.','x/y','x\\y','','CON','com1','nul.data'])assert.throws(()=>libs.createIn({parent:disk,name}));libs.close();libs=new Libraries(old);assert.equal(libs.current,path.join(disk,'日常.library'));}finally{libs.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('authenticated extension request sends only a foreground message to the desktop parent',{skip:process.platform==='win32'},async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'assetnest-show-')),base='http://127.0.0.1:41679';const child=fork(new URL('./server.mjs',import.meta.url),[],{env:{...process.env,ASSETNEST_DATA:root,ASSETNEST_PORT:'41679',ASSETNEST_DESKTOP:'1'},stdio:['ignore','ignore','ignore','ipc']});
 try{let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);const boot=await(await fetch(base+'/api/bootstrap')).json();let count=0;child.on('message',()=>count++);
 assert.equal((await fetch(base+'/api/desktop/show',{method:'POST',headers:{Origin:'chrome-extension://test'}})).status,401);
 assert.equal((await fetch(base+'/api/desktop/show',{method:'POST',headers:{Origin:'https://untrusted.test','X-Assetnest-Key':boot.key}})).status,403);
 const message=once(child,'message');assert.equal((await fetch(base+'/api/desktop/show',{method:'POST',headers:{Origin:'chrome-extension://test','X-Assetnest-Key':boot.key}})).status,200);assert.deepEqual((await message)[0],{type:'assetnest-show'});assert.equal(count,1);
 }finally{const exit=once(child,'exit');child.kill('SIGTERM');await exit;fs.rmSync(root,{recursive:true,force:true});}
});
