import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import crypto from 'node:crypto';
if(path.extname(process.argv[2]).toLowerCase()==='.psd'){
 process.argv[4]=process.argv[3];process.argv[3]='--thumbnail';await import('./psd-worker.mjs');
}else try{
 const file=process.argv[2];if(fs.statSync(file).size>256*1024*1024)throw Error('文件超过缩略图上限 256MB');
 const source=fs.readFileSync(file);if(process.argv[3]&&crypto.createHash('sha256').update(source).digest('hex')!==process.argv[3])throw Error('原文件内容已变化，请刷新素材库后重试');const bytes=await sharp(source,{limitInputPixels:40000000,pages:1}).timeout({seconds:15}).rotate().resize(480,480,{fit:'inside',withoutEnlargement:true}).png().toBuffer();process.stdout.write(bytes);
}catch(e){process.stderr.write(e.message);process.exitCode=1;}
