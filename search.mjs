import {validateRules,compileRules,safePattern} from './smart-rules.mjs';
const error=message=>Object.assign(new Error(message),{status:400});
export const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('en-US');
export function setupSearch(db){
 db.function('assetnest_regex',(pattern,text)=>safePattern(pattern).test(String(text??'').slice(0,4000))?1:0);
 db.exec('CREATE TABLE IF NOT EXISTS media_info(id TEXT PRIMARY KEY,hash TEXT NOT NULL,width REAL,height REAL,duration REAL)');
 db.exec(`CREATE TABLE IF NOT EXISTS search_docs(id TEXT PRIMARY KEY,text TEXT NOT NULL,name TEXT NOT NULL,ext TEXT NOT NULL,width REAL,height REAL,star INTEGER NOT NULL,deleted INTEGER NOT NULL,created REAL NOT NULL,size REAL NOT NULL,tags TEXT NOT NULL,folders TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS search_date ON search_docs(deleted,created DESC,id);
 CREATE INDEX IF NOT EXISTS search_ext ON search_docs(deleted,ext);
 CREATE INDEX IF NOT EXISTS search_star ON search_docs(deleted,star);
 CREATE INDEX IF NOT EXISTS search_dimensions ON search_docs(deleted,width,height);
 CREATE TABLE IF NOT EXISTS smart_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,conditions TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS image_features(id TEXT PRIMARY KEY,hash TEXT NOT NULL,algorithm TEXT NOT NULL,status TEXT NOT NULL,width INTEGER,height INTEGER,palette TEXT,phash TEXT,error TEXT);
 CREATE INDEX IF NOT EXISTS features_status ON image_features(status);`);
 // Catalog writes already update the index in the same transaction. Only fill
 // missing documents on open; rewriting every document made warm starts O(data).
 db.exec('BEGIN IMMEDIATE');try{db.exec('DELETE FROM search_docs WHERE id NOT IN (SELECT id FROM items)');for(const row of db.prepare('SELECT i.id,i.metadata FROM items i LEFT JOIN search_docs s ON s.id=i.id WHERE s.id IS NULL').iterate())syncDocument(db,row);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
export function syncDocument(db,row){const m=JSON.parse(row.metadata),number=value=>Number.isFinite(Number(value))?Number(value):0;db.prepare('INSERT OR REPLACE INTO search_docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,normalized([m.name,m.url,m.annotation,...(m.tags||[])].join(' ')),normalized(m.name),String(m.ext||'').toLowerCase(),number(m.width),number(m.height),number(m.star),m.isDeleted?1:0,number(m.modificationTime),number(m.size),JSON.stringify(m.tags||[]),JSON.stringify(m.folders||[]));}
const numeric={minWidth:[0,1000000],maxWidth:[0,1000000],minHeight:[0,1000000],maxHeight:[0,1000000],minRatio:[0,10000],maxRatio:[0,10000],minRating:[0,5],maxRating:[0,5],after:[0,1e15],before:[0,1e15],colorTolerance:[0,441]};
const keys=new Set(['includeDescendants','rules','itemId','q','ext','tag','folderId','deleted','starred','recent','unclassified','untagged','randomSeed','source','sort','color',...Object.keys(numeric)]);
export function validateConditions(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw error('筛选条件必须是对象');const output={};
 for(const [key,value]of Object.entries(input)){if(!keys.has(key))throw error('未知筛选条件：'+key);if(value===''||value===null||value===undefined)continue;
  if(key==='rules')output[key]=validateRules(value);
  else if(key in numeric){const [min,max]=numeric[key],n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw error(key+' 超出范围');output[key]=n;}
  else if(['includeDescendants','deleted','starred','recent','unclassified','untagged'].includes(key)){if(![true,false,'true','false'].includes(value))throw error(key+' 必须为布尔值');output[key]=value===true||value==='true';}
  else if(key==='randomSeed'){const n=Number(value);if(!Number.isInteger(n)||n<1||n>65535)throw error('随机种子无效');output[key]=n;}
  else{if(typeof value!=='string'||value.length>1000)throw error(key+' 格式无效');output[key]=value;}
 }
 if(output.sort&&!['newest','oldest','name','size','rating'].includes(output.sort))throw error('排序方式无效');if(output.color&&!/^#[0-9a-f]{6}$/i.test(output.color))throw error('颜色需要为 #RRGGBB');
 for(const [min,max]of [['minWidth','maxWidth'],['minHeight','maxHeight'],['minRatio','maxRatio'],['minRating','maxRating'],['after','before']])if(output[min]!==undefined&&output[max]!==undefined&&output[min]>output[max])throw error('筛选下限大于上限');return output;
}
export function compileSearch(conditions={},now=Date.now()){
 const c=validateConditions(conditions),clauses=['s.deleted=?'],params=[c.deleted?1:0],add=(sql,value)=>{clauses.push(sql);params.push(value);};
 for(const word of normalized(c.q||'').trim().split(/\s+/).filter(Boolean))add('instr(s.text,?)>0',word);
 if(c.itemId)add('s.id=?',c.itemId);
 if(c.ext){if(c.ext==='jpg')clauses.push("s.ext IN ('jpg','jpeg')");else add('s.ext=?',c.ext.toLowerCase());}
 if(c.tag)add('EXISTS(SELECT 1 FROM json_each(s.tags) WHERE value=?)',c.tag);
 if(c.folderId)add(c.includeDescendants?'EXISTS(SELECT 1 FROM json_each(s.folders) WHERE value IN (WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? UNION SELECT f.id FROM folder_index f JOIN subtree p ON f.parent_id=p.id) SELECT id FROM subtree))':'EXISTS(SELECT 1 FROM json_each(s.folders) WHERE value=?)',c.folderId);
 if(c.source)add(c.source==='__local'?'src.pack_id IS ?':'src.pack_id=?',c.source==='__local'?null:c.source);
 const w='coalesce(f.width,mi.width,s.width)',h='coalesce(f.height,mi.height,s.height)',ratio=`(${w}*1.0/nullif(${h},0))`;
 if(c.rules){const group=compileRules(c.rules,{w,h,ratio});clauses.push(group.sql);params.push(...group.params);}
 for(const [key,col,op]of [['minWidth',w,'>='],['maxWidth',w,'<='],['minHeight',h,'>='],['maxHeight',h,'<='],['minRatio',ratio,'>='],['maxRatio',ratio,'<='],['minRating','s.star','>='],['maxRating','s.star','<='],['after','s.created','>='],['before','s.created','<=']])if(c[key]!==undefined)add(col+op+'?',c[key]);
 if(c.starred)clauses.push('s.star>0');if(c.recent)add('s.created>=?',now-7*86400000);
 if(c.unclassified)clauses.push('json_array_length(s.folders)=0');if(c.untagged)clauses.push('json_array_length(s.tags)=0');
 if(c.color){const rgb=[1,3,5].map(i=>parseInt(c.color.slice(i,i+2),16)),tol=c.colorTolerance??80;clauses.push(`EXISTS(SELECT 1 FROM json_each(CASE WHEN f.status='ready' THEN f.palette ELSE coalesce(json_extract(i.metadata,'$.palettes'),'[]') END) p WHERE (json_extract(p.value,'$.color[0]')-?)*(json_extract(p.value,'$.color[0]')-?)+(json_extract(p.value,'$.color[1]')-?)*(json_extract(p.value,'$.color[1]')-?)+(json_extract(p.value,'$.color[2]')-?)*(json_extract(p.value,'$.color[2]')-?)<=?)`);params.push(rgb[0],rgb[0],rgb[1],rgb[1],rgb[2],rgb[2],tol*tol);}
 const from='FROM search_docs s JOIN items i ON i.id=s.id LEFT JOIN item_sources src ON src.id=s.id LEFT JOIN image_features f ON f.id=s.id AND f.hash=i.hash LEFT JOIN media_info mi ON mi.id=s.id AND mi.hash=i.hash',where='WHERE '+clauses.join(' AND '),order=c.randomSeed?`((s.rowid*${c.randomSeed*2+1}*48271)%2147483647) ASC`:({oldest:'s.created ASC',name:'s.name ASC',size:'s.size DESC',rating:'s.star DESC'})[c.sort]||'s.created DESC';return {from,where,params,order:order+',s.id ASC',conditions:c};
}
export function queryItems(catalog,conditions={},options={}){
 const limit=Number(options.limit??60),page=Number(options.page??1);if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(page)||page<1||page>1000000)throw error('分页参数无效');
 const q=compileSearch(conditions),db=catalog.db,total=db.prepare(`SELECT count(*) AS n ${q.from} ${q.where}`).get(...q.params).n;
 const rows=db.prepare(`SELECT i.*,coalesce(f.width,mi.width) AS analyzed_width,coalesce(f.height,mi.height) AS analyzed_height,f.palette AS extracted_palette,f.status AS analysis_status ${q.from} ${q.where} ORDER BY ${q.order} LIMIT ? OFFSET ?`).all(...q.params,limit,(page-1)*limit);
 return {rows,total,page,limit,pages:Math.ceil(total/limit),conditions:q.conditions};
}
export function searchIds(catalog,conditions){const q=compileSearch(conditions);return catalog.db.prepare(`SELECT i.id ${q.from} ${q.where} ORDER BY ${q.order}`).all(...q.params).map(r=>r.id);}
export function searchFacets(catalog){const db=catalog.db;return {trash:db.prepare('SELECT count(*) AS n FROM search_docs WHERE deleted=1').get().n,total:db.prepare('SELECT count(*) AS n FROM search_docs WHERE deleted=0').get().n,unclassified:db.prepare('SELECT count(*) AS n FROM search_docs WHERE deleted=0 AND json_array_length(folders)=0').get().n,untagged:db.prepare('SELECT count(*) AS n FROM search_docs WHERE deleted=0 AND json_array_length(tags)=0').get().n,folders:db.prepare('SELECT value AS id,count(*) AS n FROM search_docs,json_each(folders) WHERE deleted=0 GROUP BY value').all(),tags:db.prepare('SELECT value AS name,count(*) AS n FROM search_docs,json_each(tags) GROUP BY value ORDER BY value').all(),sources:db.prepare('SELECT DISTINCT pack_id AS id FROM item_sources WHERE pack_id IS NOT NULL').all()};}

export function folderSubtreeCounts(catalog){return catalog.db.prepare(`WITH RECURSIVE tree(root,id) AS (SELECT id,id FROM folders UNION SELECT tree.root,f.id FROM folder_index f JOIN tree ON f.parent_id=tree.id) SELECT tree.root AS id,count(DISTINCT s.id) AS n FROM tree JOIN search_docs s JOIN json_each(s.folders) j ON j.value=tree.id WHERE s.deleted=0 GROUP BY tree.root`).all();}
