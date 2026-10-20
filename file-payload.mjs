import fs from 'node:fs';
import crypto from 'node:crypto';
export const filePayload=file=>({kind:'assetnest-file',path:file,length:fs.statSync(file).size});
export const isFilePayload=value=>value?.kind==='assetnest-file'&&typeof value.path==='string';
export function payloadBytes(value){return isFilePayload(value)?fs.readFileSync(value.path):Buffer.from(value);}
export function payloadHash(value){if(!isFilePayload(value))return crypto.createHash('sha256').update(value).digest('hex');const hash=crypto.createHash('sha256'),fd=fs.openSync(value.path,'r'),chunk=Buffer.alloc(256*1024);try{let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null)))hash.update(chunk.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
export function writePayload(file,value){if(isFilePayload(value)){if(fs.lstatSync(value.path).isSymbolicLink()||!fs.statSync(value.path).isFile())throw Error('暂存来源必须为普通文件');fs.copyFileSync(value.path,file);const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}else{const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
