import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function psdDimensions(header){if(header.length<26||header.toString('ascii',0,4)!=='8BPS'||header.readUInt16BE(4)!==1)throw Error('不是有效的 PSD 文件');const width=header.readUInt32BE(18),height=header.readUInt32BE(14);if(!width||!height)throw Error('PSD 尺寸无效');return {width,height};}
export function psdFileDimensions(file){const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(26);fs.readSync(fd,b,0,26,0);return psdDimensions(b);}finally{fs.closeSync(fd);}}
let queue=Promise.resolve();
export function decodePsd(file,{expectedHash=''}={}){const run=()=>new Promise((resolve,reject)=>{execFile(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./psd-worker.mjs',import.meta.url)),file,'--full',expectedHash],{windowsHide:true,timeout:30000,maxBuffer:70*1024*1024,encoding:'buffer'},(error,stdout,stderr)=>{if(error)return reject(Object.assign(Error(error.killed?'PSD 预览生成超时':stderr.toString().trim().slice(0,500)||'PSD 预览生成失败'),{status:422}));resolve(stdout);});});const operation=queue.then(run,run);queue=operation.then(()=>{},()=>{});return operation;}
