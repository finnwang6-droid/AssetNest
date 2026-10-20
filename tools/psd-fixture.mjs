export function fixturePsd(width=8,height=6,{rle=false}={}){
 const header=Buffer.alloc(38);header.write('8BPS');header.writeUInt16BE(1,4);header.writeUInt16BE(3,12);header.writeUInt32BE(height,14);header.writeUInt32BE(width,18);header.writeUInt16BE(8,22);header.writeUInt16BE(3,24);const compression=Buffer.alloc(2);compression.writeUInt16BE(rle?1:0);
 const colors=[220,90,40];if(!rle)return Buffer.concat([header,compression,...colors.map(v=>Buffer.alloc(width*height,v))]);
 if(width>128)throw Error('RLE fixture width max 128');const counts=Buffer.alloc(height*3*2);for(let n=0;n<height*3;n++)counts.writeUInt16BE(2,n*2);return Buffer.concat([header,compression,counts,...colors.flatMap(v=>Array.from({length:height},()=>Buffer.from([257-width,v])))]);
}
