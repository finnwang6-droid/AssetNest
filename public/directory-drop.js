const limits={files:5000,folders:500,depth:20,fileBytes:256*1024**2,totalBytes:2*1024**3};
const systemName=name=>name.startsWith('.')||/^(thumbs\.db|desktop\.ini)$/i.test(name);
const unsafeFile=name=>/\.(exe|com|bat|cmd|ps1|msi|dll|lnk)$/i.test(name);
function segment(value){if(typeof value!=='string'||!value||value.length>200||/[\\/\x00-\x1f]/.test(value)||['.','..'].includes(value))throw Error('文件夹或文件名称无效');return value;}
export async function collectDroppedEntries(dataTransfer){
 // Read these handles synchronously while the browser still exposes drop data.
 const entries=[...(dataTransfer.items||[])].filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.()||null),fallback=[...(dataTransfer.files||[])];
 const folders=[],files=[],seen=new Set();let skipped=0,totalBytes=0;
 function folder(parts){if(parts.length>limits.depth)throw Error('文件夹层级超过 20 层');const key=parts.join('/');if(!seen.has(key)){if(folders.length>=limits.folders)throw Error('一次最多导入 500 个文件夹');seen.add(key);folders.push({key,name:parts.at(-1),parent:parts.slice(0,-1).join('/')});}}
 function file(value,parts){if(systemName(value.name)||unsafeFile(value.name)||!/[.]([a-z0-9]{1,12})$/i.test(value.name)){skipped++;return;}if(value.size>limits.fileBytes)throw Error('文件「'+value.name+'」超过 256 MB，请分开处理');if(files.length>=limits.files)throw Error('一次最多导入 5000 个文件');totalBytes+=value.size;if(totalBytes>limits.totalBytes)throw Error('一次导入的文件总量不能超过 2 GB');files.push({file:value,parent:parts.join('/')});}
 async function walk(entry,parts=[]){const name=segment(entry.name);if(systemName(name)){skipped++;return;}if(entry.isDirectory){if(/\.library$/i.test(name))throw Error('这是素材库目录，请通过“切换与管理素材库”打开，不要作为普通文件夹导入');const next=[...parts,name];folder(next);const reader=entry.createReader();for(;;){const children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!children.length)break;for(const child of children)await walk(child,next);}}else if(entry.isFile){const value=await new Promise((resolve,reject)=>entry.file(resolve,reject));file(value,parts);}}
 if(entries.some(Boolean)){if(entries.some(entry=>!entry))throw Error('浏览器没有提供完整的拖入内容，请分批拖入');for(const entry of entries)await walk(entry);}
 else for(const value of fallback){const relative=value.webkitRelativePath;if(relative){const parts=relative.split('/').map(segment);if(parts.slice(0,-1).some(systemName)){skipped++;continue;}if(parts.slice(0,-1).some(name=>/\.library$/i.test(name)))throw Error('这是素材库目录，请通过“切换与管理素材库”打开');for(let n=1;n<parts.length;n++)folder(parts.slice(0,n));file(value,parts.slice(0,-1));}else file(value,[]);}
 return {folders,files,skipped,totalBytes};
}
export function installDirectoryDrop({api,getLibraryId,getFolders,onDone,onStatus,onReport}){
 let running=false;
 return async function importDrop(dataTransfer,parentId=null){
  if(running)throw Error('已有文件夹正在导入，请等待完成后再拖入');running=true;
  const library=getLibraryId(),created=new Map(),known=getFolders().map(f=>({...f})),report={libraryId:library,foldersCreated:0,added:0,duplicates:0,skipped:0,failures:[],rootIds:[]};
  const check=()=>{if(getLibraryId()!==library)throw Error('素材库已切换，导入已停止；已经完成的内容保留在原库');};
  const request=async(route,options={})=>{check();return api(route,{...options,headers:{...options.headers,'X-Assetnest-Library':library}});};
  try{
   onStatus('正在读取文件夹结构…');const plan=await collectDroppedEntries(dataTransfer);check();report.skipped=plan.skipped;
   // Validate the entire traversal before creating anything in the catalog.
   for(const entry of plan.folders){check();const parent=entry.parent?created.get(entry.parent):parentId;let name=entry.name,n=2;while(known.some(f=>(f.parentId||null)===(parent||null)&&f.name===name))name=entry.name+' ('+n+++')';const response=await request('folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,parentId:parent||null})});const saved=await response.json();created.set(entry.key,saved.id);known.push({id:saved.id,name,parentId:parent||null});report.foldersCreated++;if(!entry.parent)report.rootIds.push(saved.id);}
   for(let n=0;n<plan.files.length;n++){check();const entry=plan.files[n],folderId=entry.parent?created.get(entry.parent):parentId;onStatus('正在导入 '+(n+1)+' / '+plan.files.length+'：'+entry.file.name);try{const response=await request('upload',{method:'POST',headers:{'X-File-Name':encodeURIComponent(entry.file.name),...(folderId?{'X-Assetnest-Folder':folderId}:{})},body:entry.file});const saved=await response.json();saved.duplicate?report.duplicates++:report.added++;}catch(e){check();report.failures.push({name:entry.file.name,folder:entry.parent,error:e.message});}}
   await onDone(report);onStatus('已创建 '+report.foldersCreated+' 个文件夹，导入 '+report.added+' 项'+(report.duplicates?'，归类已有素材 '+report.duplicates+' 项':'')+(report.skipped?'，跳过 '+report.skipped+' 个系统或不支持的文件':'')+(report.failures.length?'，失败 '+report.failures.length+' 项':''));if(report.failures.length)onReport(report);return report;
  }catch(e){await onDone(report).catch(()=>{});throw Error(e.message+'（已创建 '+report.foldersCreated+' 个文件夹，已导入 '+report.added+' 项）');}finally{running=false;}
 };
}
