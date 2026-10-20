// Decode composites in a bounded child process; never rewrite the Photoshop document.
import fs from 'node:fs';
import sharp from 'sharp';
import crypto from 'node:crypto';
import {readPsd,initializeCanvas} from 'ag-psd';
import {psdDimensions} from './psd-preview.mjs';
try{
 const file=process.argv[2];if(fs.statSync(file).size>256*1024*1024)throw Error('PSD 超过预览上限 256MB');
 const fd=fs.openSync(file,'r'),header=Buffer.alloc(26);try{fs.readSync(fd,header,0,26,0);}finally{fs.closeSync(fd);}const {width,height}=psdDimensions(header);if(width*height>40000000||width>30000||height>30000)throw Error('PSD 超过预览上限 4000 万像素');
 initializeCanvas(()=>{throw Error('PSD 预览不需要画布');},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
 const source=fs.readFileSync(file);if(process.argv[4]&&crypto.createHash('sha256').update(source).digest('hex')!==process.argv[4])throw Error('原文件内容已变化，请刷新素材库后重试');const actual=psdDimensions(source);if(actual.width!==width||actual.height!==height)throw Error('PSD 读取期间发生变化，请重试');
 const document=readPsd(source,{useImageData:true,skipLayerImageData:true,skipLinkedFilesData:true,skipThumbnail:true,totalMemoryLimit:256*1024*1024}),image=document.imageData;if(!image?.data?.length)throw Error('PSD 没有可读取的合成预览，请在 Photoshop 保存时启用最大兼容性');
 let pixels=image.data;if(pixels instanceof Uint16Array)pixels=Uint8Array.from(pixels,v=>Math.round(v/257));else if(pixels instanceof Float32Array)pixels=Uint8Array.from(pixels,(v,i)=>Math.round(Math.max(0,Math.min(1,i%4===3?v:Math.pow(Math.max(0,v),1/2.2)))*255));
 const scale=process.argv[3]==='--thumbnail'?Math.min(1,480/Math.max(width,height)):Math.min(1,16000/Math.max(width,height),Math.sqrt(16000000/(width*height))),bytes=await sharp(Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength),{raw:{width,height,channels:4},limitInputPixels:40000000}).resize(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))).png().toBuffer();process.stdout.write(bytes);
}catch(e){process.stderr.write(e.message);process.exitCode=1;}
