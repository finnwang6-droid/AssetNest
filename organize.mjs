import {fail} from './storage.mjs';

function strings(value,label){if(!Array.isArray(value)||value.length>200||value.some(v=>typeof v!=='string'||!v.trim()||v.length>1000))throw fail(label+'格式无效');return [...new Set(value)];}
export function prepareEdit(catalog,id,patch){
 const row=catalog.row(id);if(!row)throw fail('素材不存在：'+id,404);
 const metadata=JSON.parse(row.metadata),source=catalog.source(id),disk=source?.file_metadata?JSON.parse(source.file_metadata):null,changes={};
 for(const key of ['name','tags','folders','annotation','star','isDeleted'])if(patch[key]!==undefined)changes[key]=patch[key];
 if(changes.name!==undefined&&(typeof changes.name!=='string'||!changes.name.trim()||changes.name.length>1000||/[\/\\\x00-\x1f]/.test(changes.name)))throw fail('素材名称无效');
 for(const key of ['tags','folders'])if(changes[key]!==undefined)changes[key]=strings(changes[key],key);
 if(changes.folders?.some(id=>!catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(id)))throw fail('目标文件夹不存在');
 if(changes.annotation!==undefined&&(typeof changes.annotation!=='string'||changes.annotation.length>100000))throw fail('注释格式无效');
 if(changes.star!==undefined&&(!Number.isInteger(changes.star)||changes.star<0||changes.star>5))throw fail('评分需要为 0～5');
 if(changes.isDeleted!==undefined&&typeof changes.isDeleted!=='boolean')throw fail('回收站状态无效');
 changes.lastModified=Date.now();Object.assign(metadata,changes);if(disk)Object.assign(disk,changes);
 return {row:{...row,metadata:JSON.stringify(metadata)},source:{file_metadata:disk?JSON.stringify(disk):null,pack_id:source?.pack_id??null}};
}
export function batchEdit(catalog,p){
 if(!Array.isArray(p.ids)||!p.ids.length||p.ids.length>500||new Set(p.ids).size!==p.ids.length)throw fail('请选择 1～500 个不同素材');
 const addTags=p.addTags===undefined?[]:strings(p.addTags,'标签'),removeTags=p.removeTags===undefined?[]:strings(p.removeTags,'标签');
 const plans=p.ids.map((id,index)=>{
  const row=catalog.row(id);if(!row)throw fail('素材不存在：'+id,404);const current=JSON.parse(row.metadata),patch={...(p.patch||{})};
  if(addTags.length||removeTags.length)patch.tags=[...new Set([...(current.tags||[]),...addTags])].filter(t=>!removeTags.includes(t));
  if(p.folderMode){if(!['add','replace','remove'].includes(p.folderMode))throw fail('文件夹操作无效');const folders=strings(p.folders||[],'文件夹');patch.folders=p.folderMode==='replace'?folders:p.folderMode==='add'?[...new Set([...(current.folders||[]),...folders])]:(current.folders||[]).filter(f=>!folders.includes(f));}
  if(p.rename){if(typeof p.rename.template!=='string'||!p.rename.template.trim())throw fail('改名模板不能为空');const start=p.rename.start??1;if(!Number.isInteger(start)||start<0||start>1000000)throw fail('编号起点无效');patch.name=p.rename.template.replace(/\{name\}/g,()=>current.name).replace(/\{n\}/g,String(start+index));}
  return prepareEdit(catalog,id,patch);
 });catalog.commit({items:plans});return {updated:plans.length,ids:p.ids};
}
export function manageTag(catalog,{from,to=null}){
 if(typeof from!=='string'||!from.trim()||to!==null&&(typeof to!=='string'||!to.trim()||to.length>1000))throw fail('标签名称无效');
 const plans=catalog.db.prepare('SELECT id,metadata FROM items').all().filter(r=>(JSON.parse(r.metadata).tags||[]).includes(from)).map(r=>prepareEdit(catalog,r.id,{tags:[...new Set(JSON.parse(r.metadata).tags.flatMap(t=>t===from?(to===null?[]:[to]):[t]))]}));
 if(plans.length)catalog.commit({items:plans});return {updated:plans.length};
}
export function editFolder(catalog,id,p){
 const folders=catalog.folders().map(f=>({id:f.id,parentId:f.parent_id,raw:JSON.parse(f.metadata)})),target=folders.find(f=>f.id===id);if(!target)throw fail('文件夹不存在',404);
 if(p.name!==undefined){if(typeof p.name!=='string'||!p.name.trim()||p.name.length>200||/[\x00-\x1f]/.test(p.name))throw fail('文件夹名称无效');target.raw.name=p.name.trim();}
 if(p.parentId!==undefined){if(p.parentId!==null&&typeof p.parentId!=='string')throw fail('父文件夹无效');target.parentId=p.parentId||null;}
 if(p.order!==undefined){if(!Number.isFinite(p.order)||Math.abs(p.order)>1000000)throw fail('排序值无效');target.raw.order=p.order;}
 if(p.icon!==undefined){if(typeof p.icon!=='string'||!/^([a-zA-Z0-9_-]{1,64})?$/.test(p.icon))throw fail('文件夹图标无效');target.raw.icon=p.icon;}
 if(p.iconColor!==undefined){if(!['','red','orange','yellow','green','aqua','blue','purple','pink'].includes(p.iconColor))throw fail('文件夹颜色无效');target.raw.iconColor=p.iconColor;}
 if(p.sort!==undefined){if(!['name-asc','name-desc'].includes(p.sort))throw fail('文件夹排序方式无效');folders.filter(f=>f.parentId===target.parentId).sort((a,b)=>a.raw.name.localeCompare(b.raw.name,'zh-CN',{numeric:true})*(p.sort==='name-desc'?-1:1)).forEach((f,n)=>f.raw.order=n);}
 for(const folder of folders){const seen=new Set();let current=folder;while(current){if(seen.has(current.id))throw fail('不能移动到自身或子文件夹');seen.add(current.id);if(current.parentId&&!folders.some(f=>f.id===current.parentId))throw fail('父文件夹不存在');current=folders.find(f=>f.id===current.parentId);}}
 function raw(folder){const value={...folder.raw};const children=folders.filter(f=>f.parentId===folder.id).sort((a,b)=>(a.raw.order||0)-(b.raw.order||0));if(children.length||Object.hasOwn(value,'children'))value.children=children.map(raw);return value;}
 catalog.commit({folders:folders.map(f=>({...f,raw:raw(f)}))});return {id,...target.raw,parentId:target.parentId};
}

// Removing a folder only removes memberships. Originals and other memberships remain intact.
export function deleteFolder(catalog,id){
 const folders=catalog.folders();if(!folders.some(f=>f.id===id))throw fail('文件夹不存在',404);
 const removed=new Set([id]),pending=[id];while(pending.length){const parent=pending.pop();for(const f of folders)if(f.parent_id===parent&&!removed.has(f.id)){removed.add(f.id);pending.push(f.id);}}
 const remaining=folders.filter(f=>!removed.has(f.id));
 function raw(f){return {...JSON.parse(f.metadata),children:remaining.filter(c=>c.parent_id===f.id).map(raw)};}
 const items=catalog.db.prepare('SELECT id,metadata FROM items').all().filter(r=>(JSON.parse(r.metadata).folders||[]).some(f=>removed.has(f))).map(r=>prepareEdit(catalog,r.id,{folders:(JSON.parse(r.metadata).folders||[]).filter(f=>!removed.has(f))}));
 catalog.commit({items,deleteFolders:[...removed],folders:remaining.map(f=>({id:f.id,parentId:f.parent_id,raw:raw(f)}))});
 return {removedIds:[...removed],updatedItems:items.length,originalsPreserved:true};
}
