import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {resolveContextImage,captureMenus} from './extension/context-image.js';
import {installContextTracking} from './extension/context-bootstrap.js';
const rect={left:10,right:110,top:10,bottom:110,width:100,height:100};
function element(tag,extra={}){return {tagName:tag,getBoundingClientRect:()=>rect,querySelectorAll:()=>[],getAttribute:()=>null,parentElement:null,...extra};}
function resolve(stack,extra={},input={}){const context={URL,Date,location:{href:'https://example.test/page'},document:{baseURI:'https://example.test/page',elementsFromPoint:()=>stack},innerWidth:1000,innerHeight:800,getComputedStyle:el=>({backgroundImage:el.background||'none'}),__assetnestContextTarget:{x:50,y:50,at:Date.now(),pageURL:'https://example.test/page'},...extra};return vm.runInNewContext('('+resolveContextImage.toString()+')('+JSON.stringify(input)+')',context);}
test('save-image context menu is available on image, overlay link and page targets',()=>{assert.deepEqual(captureMenus.find(m=>m.id==='assetnest-save').contexts,['image','link','page']);});
test('overlay links resolve the covered sibling image without choosing an adjacent card',()=>{
 const img=element('IMG',{currentSrc:'https://images.test/photo.png',alt:'photo'}),other=element('IMG',{src:'https://images.test/other.png',getBoundingClientRect:()=>({...rect,left:150,right:250})}),parent=element('DIV',{querySelectorAll:()=>[img,other]}),overlay=element('A',{parentElement:parent});assert.equal(resolve([overlay,parent]).url,img.currentSrc);assert.equal(resolve([overlay,parent]).name,'photo');parent.querySelectorAll=()=>[other];assert.equal(resolve([overlay,parent]).ok,false);
});
test('backgrounds, direct image URLs, expired positions and changed frames have explicit outcomes',()=>{
 assert.equal(resolve([element('DIV',{background:'url("/background.png?sig=keep")'})]).url,'https://example.test/background.png?sig=keep');assert.equal(resolve([],{__assetnestContextTarget:null},{srcUrl:'https://images.test/direct.png'}).ok,true);assert.equal(resolve([],{__assetnestContextTarget:null}).ok,false);assert.equal(resolve([],{__assetnestContextTarget:{x:50,y:50,at:0,pageURL:'https://example.test/page'}}).ok,false);assert.equal(resolve([],{}, {frameURL:'https://example.test/other'}).ok,false);assert.equal(resolve([element('BODY',{background:'url(/page-decoration.png)'})]).ok,false);
});
test('context listener records only a right click and never blocks the browser menu or sends page data',()=>{
 const handlers={};let registrations=0;const context={Date,location:{href:'https://example.test/'},window:{addEventListener:(type,fn,capture)=>{assert.equal(capture,true);handlers[type]=fn;registrations++;}}};const source=fs.readFileSync(new URL('./extension/context-target.js',import.meta.url),'utf8');vm.runInNewContext(source,context);vm.runInNewContext(source,context);assert.equal(registrations,3);handlers.pointerdown({type:'pointerdown',button:0,clientX:99,clientY:99});assert.equal(context.__assetnestContextTarget,undefined);handlers.pointerdown({type:'pointerdown',button:2,clientX:12,clientY:34});assert.equal(context.__assetnestContextTarget.x,12);assert.equal(context.__assetnestContextTarget.y,34);assert.deepEqual(Object.keys(context.__assetnestContextTarget).sort(),['at','pageURL','x','y']);handlers.contextmenu({type:'contextmenu',clientX:45,clientY:67});assert.equal(context.__assetnestContextTarget.x,45);
});
test('installation backfills existing web tabs even when one tab denies injection',async()=>{
 const calls=[];await installContextTracking({tabs:{query:async query=>{assert.deepEqual(query,{url:['http://*/*','https://*/*']});return [{id:4},{id:5},{}];}},scripting:{executeScript:async args=>{calls.push(args);if(args.target.tabId===4)throw Error('restricted');}}});assert.deepEqual(calls.map(c=>c.target.tabId),[4,5]);assert.ok(calls.every(c=>c.target.allFrames&&c.files[0]==='context-target.js'));
});
