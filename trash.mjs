import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {digest,fail,validId} from './storage.mjs';

function directoryContents(root){
 const files=[];function walk(dir,prefix=''){if(!fs.existsSync(dir))return;const stat=fs.lstatSync(dir);if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('素材目录不能为链接或普通文件');for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),s=fs.lstatSync(file);if(s.isSymbolicLink())throw fail('待删除素材含目录链接，请先检查');if(s.isDirectory())walk(file,prefix+entry.name+'/');else if(s.isFile())files.push({name:prefix+entry.name,bytes:s.size,modified:s.mtimeMs});else throw fail('待删除素材含特殊文件');}}walk(root);return files.sort((a,b)=>a.name.localeCompare(b.name));
}
export class Trash{
 constructor(catalog){this.catalog=catalog;this.previews=new Map();}
 inspect(ids=null){
  const c=this.catalog;for(const dir of [c.images,c.transactions])if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw fail('素材或事务目录不能为链接');if(ids===null)ids=c.db.prepare("SELECT id FROM items WHERE json_extract(metadata,'$.isDeleted')=1 ORDER BY id").all().map(r=>r.id);
  if(!Array.isArray(ids)||!ids.length||ids.length>100000||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw fail('请选择回收站内的素材');
  const records=ids.map(id=>{const row=c.row(id);if(!row||JSON.parse(row.metadata).isDeleted!==true)throw fail('素材已恢复或已删除，请刷新回收站',409);const dir=path.resolve(c.images,id+'.info');if(path.dirname(dir)!==path.resolve(c.images))throw fail('素材目录越界');const files=directoryContents(dir);return {id,row,files};});
  return {ids:[...ids],count:ids.length,bytes:records.reduce((n,r)=>n+r.files.reduce((v,f)=>v+f.bytes,0),0),fingerprint:digest(Buffer.from(JSON.stringify(records))),names:records.slice(0,8).map(r=>JSON.parse(r.row.metadata).name)};
 }
 preview(ids=null){for(const [id,p]of this.previews)if(p.expiresAt<Date.now())this.previews.delete(id);if(this.previews.size>=10)this.previews.delete(this.previews.keys().next().value);const result=this.inspect(ids),token=crypto.randomUUID(),expiresAt=Date.now()+300000;this.previews.set(token,{...result,expiresAt});return {token,count:result.count,bytes:result.bytes,names:result.names,expiresAt,libraryId:this.catalog.libraryId,path:this.catalog.root};}
 confirm(token){const saved=this.previews.get(token);if(!saved||saved.expiresAt<Date.now())throw fail('删除确认已过期，请重新确认',409);const current=this.inspect(saved.ids);if(current.fingerprint!==saved.fingerprint)throw fail('素材或回收站状态已变化，请重新确认',409);const tx=this.catalog.commit({deleteItems:current.ids});this.previews.delete(token);return {deleted:current.count,bytes:current.bytes,ids:current.ids,pendingCleanup:fs.existsSync(path.join(this.catalog.transactions,tx))};}
}
