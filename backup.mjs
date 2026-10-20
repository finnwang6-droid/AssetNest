import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {digest,durableWrite,fail} from './storage.mjs';
import {libraryFiles} from './local-layout.mjs';
import {filePayload,payloadHash} from './file-payload.mjs';

function filesIn(dir,prefix=''){
 const found=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('备份目录中不允许链接：'+entry.name);const relative=prefix+entry.name;if(entry.isDirectory())found.push(...filesIn(path.join(dir,entry.name),relative+'/'));else if(entry.isFile())found.push(relative);else throw fail('备份中存在特殊文件');}return found;
}
export function createBackup(catalog){
 catalog.beforeBackup?.();
 const integrity=catalog.integrity();if(!integrity.healthy)throw fail('完整性检查未通过，请先查看问题报告，不生成正常备份');
 const bytes=filesIn(catalog.images).reduce((n,f)=>n+fs.statSync(path.join(catalog.images,f)).size,0)+fs.statSync(catalog.dbFile||path.join(catalog.root,'catalog.sqlite')).size;catalog.assertSpace(bytes*2);
 const backups=path.join(catalog.supportRoot||catalog.root,'backups');fs.mkdirSync(backups,{recursive:true});const target=path.join(backups,new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));fs.mkdirSync(target);
 const dbFile=path.join(target,'catalog.sqlite');catalog.db.prepare('VACUUM INTO ?').run(dbFile);fs.cpSync(catalog.images,path.join(target,'images'),{recursive:true});
 for(const name of libraryFiles)if(fs.existsSync(path.join(catalog.root,name)))fs.copyFileSync(path.join(catalog.root,name),path.join(target,name));
 const checksums=Object.fromEntries(filesIn(target).map(f=>[f,payloadHash(filePayload(path.join(target,f)))]));catalog.beforeBackup?.();const manifest={version:1,createdAt:Date.now(),items:integrity.items,checksums};durableWrite(path.join(target,'backup.json'),JSON.stringify(manifest,null,2));return {directory:target,...manifest};
}
export function verifyBackup(directory){
 const root=path.resolve(directory),manifest=JSON.parse(fs.readFileSync(path.join(root,'backup.json'),'utf8'));
 filesIn(root);
 if(manifest.version!==1||!manifest.checksums||!manifest.checksums['catalog.sqlite'])throw fail('备份清单无效');
 for(const [relative,hash]of Object.entries(manifest.checksums)){if(relative.includes('\\')||relative.split('/').some(x=>x==='..'||!x)||path.isAbsolute(relative))throw fail('备份路径无效');const target=path.resolve(root,relative);if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||payloadHash(filePayload(target))!==hash)throw fail('备份文件缺失或哈希不一致：'+relative);}
 const database=new DatabaseSync(path.join(root,'catalog.sqlite'),{readOnly:true});try{if(database.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw fail('备份数据库损坏');const rows=database.prepare('SELECT * FROM items').all();for(const row of rows){const file=path.resolve(root,'images',row.file);if(!file.startsWith(path.join(root,'images')+path.sep)||!fs.existsSync(file)||payloadHash(filePayload(file))!==row.hash)throw fail('备份原图校验失败：'+row.id);}if(rows.length!==manifest.items)throw fail('备份数量不一致');}finally{database.close();}
 return manifest;
}
export function restoreBackup(directory,target){
 const source=path.resolve(directory),dest=path.resolve(target);if(dest===source||dest.startsWith(source+path.sep)||source.startsWith(dest+path.sep))throw fail('恢复目标必须与备份目录独立');
 const manifest=verifyBackup(source);if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw fail('恢复目标必须是新目录或空目录，不覆盖现有素材库');
 fs.mkdirSync(dest,{recursive:true});fs.copyFileSync(path.join(source,'catalog.sqlite'),path.join(dest,'catalog.sqlite'));fs.cpSync(path.join(source,'images'),path.join(dest,'images'),{recursive:true});for(const name of libraryFiles)if(manifest.checksums[name])fs.copyFileSync(path.join(source,name),path.join(dest,name));return {directory:dest,items:manifest.items};
}
