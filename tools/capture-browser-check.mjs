import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import sharp from 'sharp';
const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-capture-011-'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:41770',data=path.join(temp,'data'),enabled=new Set(['/large.png','/small.png']),pictures={};
for(const [name,color,width,height] of [['large','green',1200,800],['small','green',400,300],['fail1','red',640,480],['fail2','blue',720,480]])pictures['/'+name+'.png']=await sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();
const fixture=http.createServer((req,res)=>{if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<title>Original capture fixture</title><img alt="原创测试图" src="/small.png" srcset="/small.png 400w, /large.png 1200w" sizes="400px">');return;}const bytes=pictures[req.url];if(bytes&&enabled.has(req.url)){res.setHeader('Content-Type','image/png');res.end(bytes);}else{res.statusCode=404;res.end('Missing fixture');}});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const site='http://127.0.0.1:'+fixture.address().port;
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,ASSETNEST_DATA:data,ASSETNEST_PORT:'41770'},windowsHide:true,stdio:'ignore'});
let context,worker,popup;const errors=[],report={};
const wait=async fn=>{for(let n=0;n<300;n++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('Capture browser check timed out');};
const send=async m=>{const r=await popup.evaluate(m=>chrome.runtime.sendMessage(m),m);assert.equal(r.ok,true,r.error);return r.data;};
const job=()=>worker.evaluate(async()=>(await chrome.storage.local.get('captureJob')).captureJob);
const status=(state,previousId=null)=>wait(async()=>{const j=await job();return j?.status===state&&j.id!==previousId?j:null;});
async function shot(name){
 const saved=await popup.evaluate(temp=>['job-destination','job-results','destination-info'].map(id=>{const el=document.getElementById(id),text=el.textContent;el.textContent=text.split(temp).join('D:\\AssetNest-Demo');return {id,text};}),temp);
 fs.mkdirSync(path.join(root,'test-output'),{recursive:true});await popup.locator('body').screenshot({path:path.join(root,'test-output/capture-011-'+name+'.png')});
 await popup.evaluate(saved=>{for(const {id,text}of saved)document.getElementById(id).textContent=text;},saved);
}
try{
 await wait(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension')]});
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const boot=await(await fetch(base+'/api/bootstrap')).json();await worker.evaluate(c=>chrome.storage.local.set(c),{server:base,key:boot.key});
 const page=await context.newPage();await page.goto(site+'/fixture');await page.locator('img').waitFor();await page.waitForFunction(()=>document.images[0].naturalWidth>0);
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,site+'/fixture');
 popup=await context.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.goto(worker.url().replace('background.js','popup.html')+'?results=1');
 const scan=await send({type:'scan',tabId});assert.equal(scan.images[0].pageWidth,400);assert.equal(scan.images[0].candidateWidth,1200);
 await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);await popup.reload();await popup.locator('.candidate-link').waitFor();
 assert.match(await popup.locator('.image small').innerText(),/400 × 300/);assert.match(await popup.locator('.candidate-link').getAttribute('href'),/large.png$/);
 await popup.locator('[data-candidate]').selectOption(site+'/small.png');assert.match(await popup.locator('.candidate-link').getAttribute('href'),/small.png$/);report.candidateSelection={pageDimensionsAccurate:true,previewFollowsSelection:true};
 await send({type:'enqueue',items:['large','fail1','fail2'].map(name=>({url:site+'/'+name+'.png',name,candidateSource:'srcset'}))});let saved=await status('completed');assert.equal(saved.added,1);assert.equal(saved.failures.length,2);assert.equal(saved.results[0].verified,true);assert.equal(saved.results[0].width,1200);assert.equal(saved.results[0].height,800);assert.equal(saved.results[0].destination.path,data);assert.equal(saved.target.path,data);
 await popup.locator('#job-error-list button').first().waitFor();assert.match(await popup.locator('#job-results').innerText(),/已核验.*已保存/);assert.match(await popup.locator('#job-destination').innerText(),/data/);const firstTarget=saved.target;
 await shot('failures');
 enabled.add('/fail2.png');const beforeRetry=saved.id;await popup.locator('#job-error-list button').nth(1).click();saved=await status('completed',beforeRetry);assert.equal(saved.items.length,1);assert.equal(saved.items[0].name,'fail2');assert.equal(saved.added,1);assert.equal(saved.deferredFailures.length,1);assert.deepEqual(saved.target,firstTarget);
 enabled.add('/fail1.png');await send({type:'job-retry',jobId:saved.id});saved=await status('completed');assert.equal(saved.added,1);assert.equal(saved.deferredFailures.length,0);report.retries={selectedOnly:true,unselectedFailuresPreserved:true,targetRetained:true};
 await send({type:'enqueue',items:['large','fail1'].map(name=>({url:site+'/'+name+'.png',name}))});await status('awaiting-duplicate');await popup.locator('#duplicate-panel').waitFor();await popup.locator('#duplicate-all').check();await shot('duplicates');await popup.locator('#duplicate-reuse').click();saved=await status('completed');assert.equal(saved.duplicates,2);assert.equal(saved.added,0);report.duplicates={remainingPolicyApplied:true,duplicateCount:2};
 await popup.waitForFunction(()=>document.querySelector('#job-heading').textContent.includes('采集已完成'));assert.deepEqual(errors,[]);report.pageErrors=errors;
 // A retry must stop at a switched library until the user explicitly rebinds it.
 enabled.delete('/fail1.png');await send({type:'enqueue',items:[{url:site+'/fail1.png',name:'library retry'}]});saved=await status('completed');assert.equal(saved.failures.length,1);
 const post=async(route,payload)=>{const b=await(await fetch(base+'/api/bootstrap')).json();const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Assetnest-Key':b.key,'X-Assetnest-Library':b.libraryId},body:JSON.stringify(payload)});assert.equal(r.status,200);return r.json();};
 const other=path.join(temp,'other-library');await post('libraries',{directory:other,name:'原创测试新库',create:true});await post('libraries/switch',{directory:other});enabled.add('/fail1.png');
 await send({type:'job-retry',jobId:saved.id});saved=await status('paused');assert.equal(saved.lastError.code,'LIBRARY_CHANGED');assert.equal(saved.target.path,data);assert.equal(saved.index,0);
 const bootstrap=await(await fetch(base+'/api/bootstrap')).json();const current=await(await fetch(base+'/api/items',{headers:{'X-Assetnest-Key':bootstrap.key}})).json();assert.equal(current.items.length,0);
 await send({type:'job-control',action:'resume',jobId:saved.id});saved=await status('completed');assert.equal(saved.added,1);assert.equal(saved.target.path,other);assert.equal(saved.results[0].destination.path,other);report.libraryChange={retryPausedBeforeSaving:true,explicitRebindSavedToNewLibrary:true};
 await popup.waitForFunction(()=>document.querySelector('#job-results').textContent.includes('已核验'));await shot('completed');fs.writeFileSync(path.join(root,'test-output/capture-0.11.0.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context?.close();child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));await new Promise(r=>fixture.close(r));if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('assetnest-capture-011-'))fs.rmSync(temp,{recursive:true,force:true});}
