import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {scanPage} from './extension/scanner.js';
import {candidateLabel,resultText} from './extension/capture-view.js';

test('scanner separates responsive width hints from actual page image dimensions',()=>{
 const attrs={src:'small.jpg',srcset:'small.jpg 400w, large.jpg 2400w'};
 const img={src:'https://example.test/small.jpg',currentSrc:'https://example.test/small.jpg',naturalWidth:400,naturalHeight:300,width:200,height:150,alt:'sample',getAttribute:n=>attrs[n]||null,closest:()=>null};
 const result=vm.runInNewContext('('+scanPage.toString()+')()', {URL,document:{baseURI:'https://example.test/',title:'fixture',images:[img],querySelectorAll:()=>[]},location:{href:'https://example.test/'}});
 const image=result.images[0];assert.equal(image.pageWidth,400);assert.equal(image.pageHeight,300);assert.equal(image.candidateWidth,2400);assert.equal(image.url,'https://example.test/large.jpg');assert.equal(image.currentUrl,img.currentSrc);
});

test('capture display distinguishes unverified hints, downloaded dimensions and saved destination',()=>{
 assert.match(candidateLabel({source:'data-original'}),/页面标记原图.*待下载确认/);
 assert.match(candidateLabel({source:'srcset',width:2400}),/响应式候选.*2400w/);
 assert.match(resultText({status:'added',name:'test',width:2400,height:1800,size:2048,verified:true,destination:{path:'D:/sample.library',folders:['a']}}),/已核验.*\n2400 × 1800 · 2.0 KB\n保存位置：D:\/sample.library · 分类 1 个/);
 assert.doesNotMatch(resultText({status:'added',name:'legacy'}),/已核验/);
});
