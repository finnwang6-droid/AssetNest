import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {Catalog,digest} from '../storage.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-native-drag-')),install=path.join(temp,'install'),data=path.join(temp,'data');
const port=41793,debugPort=9293,base=`http://127.0.0.1:${port}`,report={};let child,browser;
const run=(exe,args)=>{const result=spawnSync(exe,args,{windowsHide:true,encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);};
const wait=async fn=>{for(let n=0;n<300;n++){try{const result=await fn();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Native bridge check timed out');};
try{
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
 run(path.join(root,`releases/AssetNest-Setup-${version}.exe`),['/silent','/no-shortcuts','/dir='+install,'/data='+data]);
 const c=new Catalog(data),bytes=Buffer.from('native bridge original bytes'),metadata=JSON.stringify({id:'ONE',name:'示例',ext:'txt',size:bytes.length,tags:[],folders:[],modificationTime:Date.now()});
 c.commit({items:[{row:{id:'ONE',metadata,file:'ONE.info/original.txt',thumb:null,hash:digest(bytes)},source:{file_metadata:metadata,pack_id:null},files:{'original.txt':bytes}}]});c.close();
 child=spawn(path.join(install,'AssetNest.exe'),['/window-test','/port='+port,'/debug-port='+debugPort,'/data='+data],{windowsHide:true,stdio:'ignore'});
 await wait(async()=> (await fetch(base+'/api/health')).ok);await wait(async()=> (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok);
 const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{noDefaults:true});
 const page=await wait(()=>browser.contexts()[0].pages().find(p=>p.url().startsWith(base)));await page.locator('.card').waitFor();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));assert.equal(await page.evaluate(()=>window.assetnestDesktop.fileDrag),true);
 const boot=await(await fetch(base+'/api/bootstrap')).json();
 await page.evaluate(()=>{window.__nativeDragCheck=[];chrome.webview.addEventListener('message',e=>window.__nativeDragCheck.push(e.data));});
 const start=async(ids,{cancel=false,repeat=false}={})=>{
  const token=crypto.randomUUID(),second=crypto.randomUUID();await page.evaluate(({ids,libraryId,token,cancel,repeat,second})=>{chrome.webview.postMessage({type:'drag-files',ids,libraryId,token});if(cancel)chrome.webview.postMessage({type:'cancel-file-drag',token});if(repeat)chrome.webview.postMessage({type:'drag-files',ids,libraryId,token:second});},{ids,libraryId:boot.libraryId,token,cancel,repeat,second});
  const finished=await wait(()=>page.evaluate(token=>window.__nativeDragCheck.find(e=>e.token===token&&e.type==='native-drag-finished'),token));return {token,second,finished};
 };
 const released=await start(['ONE']);assert.equal(released.finished.result,'released-before-ready');assert.equal(released.finished.cancelled,true);report.releaseBeforeReadyDoesNotStartOle=true;
 const cancelled=await start(['ONE'],{cancel:true});assert.equal(cancelled.finished.result,'cancelled');assert.equal(cancelled.finished.cancelled,true);report.cancelDuringPreparation=true;
 const repeated=await start(['ONE'],{repeat:true});const second=await wait(()=>page.evaluate(token=>window.__nativeDragCheck.find(e=>e.token===token&&e.type==='native-drag-finished'),repeated.second));assert.equal(second.result,'error');assert.match(second.error,/上一项拖拽/);report.overlappingGestureRejectedAndRecovers=true;
 const missing=await start(['MISSING']);assert.equal(missing.finished.result,'error');assert.match(missing.finished.error,/第 1 项/);report.missingFileFeedback=true;
 const again=await start(['ONE']);assert.equal(again.finished.result,'released-before-ready');report.newGestureAfterFailure=true;
 assert.deepEqual(errors,[]);assert.equal(digest(fs.readFileSync(path.join(data,'images/ONE.info/original.txt'))),digest(bytes));report.pageErrors=errors;report.originalUnchanged=true;
 fs.mkdirSync(path.join(root,'test-output'),{recursive:true});fs.writeFileSync(path.join(root,'test-output/native-drag-browser-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 await browser?.close();if(child&&child.exitCode===null){run(path.join(install,'AssetNest.exe'),['/stop','/port='+port]);await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,7000))]);if(child.exitCode===null)child.kill();}
 // WebView2 may retain the isolated profile briefly; all files remain in a temp directory.
}
