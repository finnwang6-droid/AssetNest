import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const root=path.resolve(import.meta.dirname,'..'),svg=fs.readFileSync(path.join(root,'assets/assetnest.svg')),sizes=[16,24,32,48,64,128,256],pngs=[];
for(const size of sizes){const png=await sharp(svg).resize(size,size).png().toBuffer();pngs.push(png);fs.writeFileSync(path.join(root,'assets',`icon-${size}.png`),png);}
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
for(let i=0;i<sizes.length;i++){const at=6+i*16;header[at]=sizes[i]===256?0:sizes[i];header[at+1]=header[at];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(pngs[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=pngs[i].length;}
fs.writeFileSync(path.join(root,'assets/assetnest.ico'),Buffer.concat([header,...pngs]));fs.copyFileSync(path.join(root,'assets/assetnest.ico'),path.join(root,'public/favicon.ico'));
const html=path.join(root,'public/index.html');if(fs.existsSync(html)){const icon='data:image/png;base64,'+pngs[sizes.indexOf(32)].toString('base64');fs.writeFileSync(html,fs.readFileSync(html,'utf8').replace(/<link rel="icon"[^>]*>/,`<link rel="icon" type="image/png" href="${icon}">`));}
for(const size of [16,32,48,128])fs.copyFileSync(path.join(root,'assets',`icon-${size}.png`),path.join(root,'extension',`icon-${size}.png`));
console.log(JSON.stringify({icoSizes:sizes,web:'public/favicon.ico',extension:[16,32,48,128]}));
