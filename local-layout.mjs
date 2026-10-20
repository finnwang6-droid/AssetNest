import fs from 'node:fs';
import path from 'node:path';
export const libraryFiles=['metadata.json','mtime.json','tags.json','saved-filters.json'];
export function assetName(value,root,id,ext){
 let name=String(value||'未命名').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().replace(/[. ]+$/,'');
 if(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='_'+name;
 const limit=Math.min(220,240-path.join(root,'images',id+'.info').length-Math.max(15,ext.length+2));
 if(limit<1)throw Object.assign(Error('素材库路径过长，请选择更短的保存路径'),{status:400});
 name=[...name].slice(0,limit).join('');while(Buffer.byteLength(name)>235)name=[...name].slice(0,-1).join('');
 if(!name)name='_';if(name.toLowerCase()==='metadata'&&ext.toLowerCase()==='json')name='_metadata';return name;
}
export function rootDocuments(catalog,changes=[],deletedIds=[]){
 const read=(name,fallback)=>{const file=path.join(catalog.root,name);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;};
 const old=read('metadata.json',{}),folders=catalog.folders().sort((a,b)=>(JSON.parse(a.metadata).order||0)-(JSON.parse(b.metadata).order||0));
 function branch(row,seen=new Set()){if(seen.has(row.id))throw Error('素材库文件夹循环引用');const next=new Set(seen).add(row.id);return {...JSON.parse(row.metadata),children:folders.filter(r=>r.parent_id===row.id).map(r=>branch(r,next))};}
 const root={...old,folders:folders.filter(r=>!r.parent_id).map(r=>branch(r)),smartFolders:old.smartFolders||[],quickAccess:old.quickAccess||[],tagsGroups:old.tagsGroups||[],modificationTime:Date.now(),applicationVersion:old.applicationVersion||'4.0.0'};
 const mtime=read('mtime.json',null)||Object.fromEntries(catalog.db.prepare("SELECT id,coalesce(json_extract(metadata,'$.lastModified'),json_extract(metadata,'$.modificationTime'),0) AS time FROM items").all().map(r=>[r.id,r.time]));for(const item of changes){const m=JSON.parse(item.row.metadata);mtime[item.row.id]=m.lastModified||m.modificationTime||0;}for(const id of deletedIds)delete mtime[id];mtime.all=catalog.db.prepare('SELECT count(*) AS n FROM items').get().n;
 return {'metadata.json':root,'mtime.json':mtime,'tags.json':read('tags.json',{historyTags:[],starredTags:[]}),'saved-filters.json':read('saved-filters.json',[])};
}
