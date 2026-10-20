import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Catalog,durableWrite,fail} from './storage.mjs';
import {createBackup,restoreBackup} from './backup.mjs';
import {isEagleLibrary,openEagleLibrary} from './eagle-library.mjs';

export class Libraries{
 constructor(initial,{config=path.join(initial,'libraries.json'),externalOptions={}}={}){
  this.config=path.resolve(config);this.initial=path.resolve(initial);this.entries=[{path:this.initial,name:'我的素材库'}];this.current=this.initial;
  this.externalOptions=externalOptions;this.externalRoot=path.join(path.dirname(this.config),'external-libraries');
  if(fs.existsSync(this.config)){const saved=JSON.parse(fs.readFileSync(this.config,'utf8'));if(saved.version!==1||!Array.isArray(saved.entries)||!saved.entries.some(e=>e.path===saved.current))throw fail('素材库配置损坏');this.entries=saved.entries;this.current=saved.current;}
  this.locationConfirmed=fs.existsSync(this.config)&&JSON.parse(fs.readFileSync(this.config,'utf8')).locationConfirmed===true;
  this.catalog=this.open(this.current);this.persist();
 }
 supportDirectory(directory){return path.join(this.externalRoot,crypto.createHash('sha256').update(fs.realpathSync(directory).toLowerCase()).digest('hex'));}
 open(directory){if(isEagleLibrary(directory))return openEagleLibrary(directory,this.supportDirectory(directory),this.externalOptions);const catalog=new Catalog(directory);catalog.kind='assetnest';try{const file=path.join(directory,'library-id');if(!fs.existsSync(file))durableWrite(file,crypto.randomUUID());catalog.libraryId=fs.readFileSync(file,'utf8').trim();return catalog;}catch(e){catalog.close();throw e;}}
 persist(){fs.mkdirSync(path.dirname(this.config),{recursive:true});const tmp=this.config+'.tmp';durableWrite(tmp,JSON.stringify({version:1,current:this.current,entries:this.entries,locationConfirmed:this.locationConfirmed},null,2));fs.renameSync(tmp,this.config);}
 list(){return {current:this.current,libraryId:this.catalog.libraryId,entries:this.entries.map(e=>({...e,kind:e.kind||(isEagleLibrary(e.path)?'eagle':'assetnest')})),locationConfirmed:this.locationConfirmed,storage:this.catalog.externalStatus?.()||{kind:'assetnest',writable:true}};}
 setup({directory,name='我的素材库',mode='create'}){
  if(!['current','create','existing','copy'].includes(mode))throw fail('保存位置模式无效');
  if(mode!=='current'){
   if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof name!=='string'||!name.trim()||name.length>200)throw fail('请输入库名称和绝对路径');
   const target=path.resolve(directory);
   if(this.entries.some(e=>{const a=e.path.toLowerCase()+path.sep,b=target.toLowerCase()+path.sep;return a.startsWith(b)||b.startsWith(a);}))throw fail('请选择与已有库独立的新目录；继续使用当前库请选择保留当前位置');
   if(mode==='copy'){
    if(fs.existsSync(target)&&fs.readdirSync(target).length)throw fail('复制目标必须为空，不覆盖已有文件');
    let ancestor=target;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);if(fs.realpathSync(ancestor).toLowerCase()!==ancestor.toLowerCase())throw fail('素材库路径不能经过目录链接');
    restoreBackup(createBackup(this.catalog).directory,target);
   }
   this.register({directory:target,name,create:mode==='create'});this.switch(target);
  }
  this.locationConfirmed=true;this.persist();return this.list();
 }
 register({directory,name,create=false}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof name!=='string'||!name.trim()||name.length>200)throw fail('请输入素材库名称与绝对路径');
  const target=path.resolve(directory);if(this.entries.some(e=>e.path.toLowerCase()===target.toLowerCase()))throw fail('该素材库已添加');
  if(this.entries.some(e=>{const a=e.path.toLowerCase()+path.sep,b=target.toLowerCase()+path.sep;return a.startsWith(b)||b.startsWith(a);}))throw fail('素材库路径不能相互嵌套');
  if(create){if(fs.existsSync(target)&&fs.readdirSync(target).length)throw fail('新库目录必须为空，不覆盖已有文件');}
  else if(!isEagleLibrary(target)&&(!fs.existsSync(path.join(target,'catalog.sqlite'))||!fs.existsSync(path.join(target,'images'))))throw fail('请选择拾素材库，或含 metadata.json 与 images 的 Eagle .library 根目录');
  // Do not accept filesystem aliases as independent libraries.
  let ancestor=target;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);if(fs.realpathSync(ancestor).toLowerCase()!==ancestor.toLowerCase())throw fail('素材库路径不能经过目录链接');
  const check=this.open(target);try{if(!check.integrity().healthy)throw fail('目标库完整性检查未通过');if(this.entries.some(e=>{const file=path.join(e.path,'library-id');return fs.existsSync(file)&&fs.readFileSync(file,'utf8').trim()===check.libraryId;}))throw fail('该目录与已有库身份相同；请通过备份恢复到新库，不直接复制运行中的素材库');}finally{check.close();}
  this.entries.push({path:target,name:name.trim(),kind:isEagleLibrary(target)?'eagle':'assetnest'});try{this.persist();}catch(e){this.entries.pop();throw e;}return this.list();
 }
 switch(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw fail('请选择素材库路径');const target=this.entries.find(e=>e.path.toLowerCase()===path.resolve(directory).toLowerCase());if(!target)throw fail('请先添加该素材库');if(target.path===this.current)return this.catalog;
  const candidate=this.open(target.path),previous=this.current;try{if(!candidate.integrity().healthy)throw fail('目标库完整性检查未通过');this.current=target.path;this.persist();}catch(e){this.current=previous;candidate.close();throw e;}
  this.catalog.close();this.catalog=candidate;return candidate;
 }
 close(){this.catalog.close();}
}
