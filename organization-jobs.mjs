import fs from 'node:fs';
import crypto from 'node:crypto';
import {prepareBatchEdit,prepareTagEdit} from './organize.mjs';
import {assetName} from './local-layout.mjs';
import {fail} from './storage.mjs';
import {filePayload,payloadHash} from './file-payload.mjs';

const fields=['name','tags','folders','star','annotation','url','isDeleted'];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class OrganizationJobs {
 constructor(catalog,{now=Date.now}={}){this.catalog=catalog;this.now=now;this.previews=new Map();}
 state(id){const row=this.catalog.row(id);return row?{row,source:this.catalog.source(id)}:null;}
 history(){const record=this.catalog.db.prepare('SELECT entry FROM organization_history WHERE slot=1').get();return record?JSON.parse(record.entry):null;}
 summary(){const h=this.history();return h?{id:h.id,label:h.label,count:h.after.length,createdAt:h.createdAt,libraryId:this.catalog.libraryId}:null;}
 validateFiles(states){for(const {row}of states){if(!fs.existsSync(this.catalog.path(row.file))||payloadHash(filePayload(this.catalog.path(row.file)))!==row.hash)throw fail('原文件缺失或内容已变化：'+JSON.parse(row.metadata).name,409);}}
 validateNames(plans){for(const {row}of plans){const m=JSON.parse(row.metadata),old=this.catalog.row(row.id);if(old&&JSON.parse(old.metadata).name===m.name)continue;if(assetName(m.name,this.catalog.root,m.id,m.ext)!==m.name)throw fail('素材名称包含无效字符、保留名称或超出本地路径长度：'+m.name);}}
 preview(p){
  for(const [id,entry]of this.previews)if(entry.expiresAt<=this.now())this.previews.delete(id);
  if(this.previews.size>=10)throw fail('预览过多，请关闭旧预览或等待 5 分钟后重试');
  if(!p||!['batch','tags'].includes(p.kind))throw fail('整理类型无效');
  const intent=structuredClone(p),plans=p.kind==='tags'?prepareTagEdit(this.catalog,p):prepareBatchEdit(this.catalog,p);
  if(plans.length>500)throw fail('一次最多整理 500 项，请先分批处理');
  this.validateNames(plans);
  const before=plans.map(i=>this.state(i.row.id));
  const changes=plans.map((plan,index)=>{const old=JSON.parse(before[index].row.metadata),next=JSON.parse(plan.row.metadata),changed=fields.filter(f=>!same(old[f],next[f]));return {id:plan.row.id,name:old.name,before:Object.fromEntries(changed.map(f=>[f,old[f]??null])),after:Object.fromEntries(changed.map(f=>[f,next[f]??null])),changed};}).filter(i=>i.changed.length);
  const changedIds=new Set(changes.map(c=>c.id)),items=plans.filter(i=>changedIds.has(i.row.id));
  const token=crypto.randomUUID(),createdAt=this.now(),label=p.kind==='tags'?(p.to===null?'移除标签':'标签重命名 / 合并'):'批量整理';
  this.previews.set(token,{id:token,intent,items,before,createdAt,expiresAt:createdAt+300000,label});
  const folders=this.catalog.folders().map(f=>({id:f.id,name:JSON.parse(f.metadata).name,parentId:f.parent_id}));
  return {token,libraryId:this.catalog.libraryId,expiresAt:createdAt+300000,label,total:plans.length,changed:changes.length,unchanged:plans.length-changes.length,changes,folders,includesTrash:before.some(s=>JSON.parse(s.row.metadata).isDeleted)};
 }
 apply(token){
  const acknowledged=this.history();if(acknowledged?.id===token)return {updated:acknowledged.after.length,id:token,replayed:true};
  const preview=this.previews.get(token);if(!preview||preview.expiresAt<=this.now())throw fail('整理预览已过期，请重新预览',409);
  for(const old of preview.before)if(!same(this.state(old.row.id),old))throw fail('素材在预览后已变化，请重新预览：'+JSON.parse(old.row.metadata).name,409);
  if(preview.intent.kind==='tags'){
   const ids=prepareTagEdit(this.catalog,preview.intent).map(i=>i.row.id);
   if(!same(ids,preview.before.map(s=>s.row.id)))throw fail('标签影响范围已变化，请重新预览',409);
  }
  if(!preview.items.length){this.previews.delete(token);return {updated:0,id:null};}
  this.validateNames(preview.items);this.validateFiles(preview.before);
  const ids=new Set(preview.items.map(i=>i.row.id)),before=preview.before.filter(s=>ids.has(s.row.id));
  // Validate folder targets again; the folder tree can change while a preview is open.
  for(const {row}of preview.items)for(const id of JSON.parse(row.metadata).folders||[])if(!this.catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(id))throw fail('目标文件夹已变化，请重新预览',409);
  this.catalog.commit({items:preview.items,organization:{id:token,label:preview.label,createdAt:this.now(),before}});
  this.previews.delete(token);return {updated:before.length,id:token};
 }
 undo(id){
  const h=this.history();if(!h||h.id!==id)throw fail('撤销记录已变化，请刷新后重试',409);
  for(const after of h.after)if(!same(this.state(after.row.id),after))throw fail('整理后的素材已被修改，无法安全撤销：'+JSON.parse(after.row.metadata).name,409);
  this.validateFiles(h.after);this.validateNames(h.before);
  for(const {row}of h.before)for(const folder of JSON.parse(row.metadata).folders||[])if(!this.catalog.db.prepare('SELECT id FROM folders WHERE id=?').get(folder))throw fail('原文件夹已删除，无法恢复归属，请手动整理',409);
  this.catalog.commit({items:h.before,organization:{clear:true}});return {restored:h.before.length};
 }
}
