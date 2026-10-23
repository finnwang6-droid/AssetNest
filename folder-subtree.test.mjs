import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Catalog,digest} from './storage.mjs';import {queryItems,searchIds,folderSubtreeCounts,validateConditions} from './search.mjs';
test('parent navigation includes descendants once, excludes siblings and trash, and keeps direct queries available',()=>{
 const c=new Catalog(fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-subtree-')));try{
 c.commit({folders:[['P',null],['C','P'],['G','C'],['S',null],['E','P']].map(([id,parentId])=>({id,parentId,raw:{id,name:id}}))});
 for(const [id,folders,isDeleted]of [['A',['P']],['B',['C']],['C',['G','C','P']],['D',['S']],['T',['G'],true]]){const bytes=Buffer.from(id),m={id,name:id,ext:'txt',folders,tags:[],isDeleted:!!isDeleted,size:1,modificationTime:1};c.commit({items:[{row:{id,metadata:JSON.stringify(m),file:id+'.info/original.txt',thumb:null,hash:digest(bytes)},files:{'original.txt':bytes}}]});}
 const conditions={folderId:'P',includeDescendants:true};assert.deepEqual(searchIds(c,conditions).sort(),['A','B','C']);assert.deepEqual(searchIds(c,{folderId:'P'}).sort(),['A','C']);assert.deepEqual(searchIds(c,{folderId:'E',includeDescendants:true}),[]);assert.deepEqual(searchIds(c,{folderId:'missing',includeDescendants:true}),[]);assert.equal(queryItems(c,conditions,{limit:1,page:2}).total,3);assert.equal(queryItems(c,conditions,{limit:1,page:2}).rows.length,1);assert.deepEqual(searchIds(c,{...conditions,deleted:true}),['T']);assert.deepEqual(Object.fromEntries(folderSubtreeCounts(c).map(f=>[f.id,f.n])),{C:2,G:1,P:3,S:1});
 c.updateItem('B',{folders:['S']});assert.equal(queryItems(c,conditions).total,2);assert.equal(folderSubtreeCounts(c).find(f=>f.id==='P').n,2);assert.throws(()=>validateConditions({includeDescendants:'anything'}));
 // UNION makes externally malformed cyclic hierarchies terminate.
 c.db.prepare('UPDATE folder_index SET parent_id=? WHERE id=?').run('G','P');assert.equal(queryItems(c,conditions).total,2);assert.ok(folderSubtreeCounts(c).length>0);
 }finally{c.close();}
});
