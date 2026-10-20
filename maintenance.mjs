import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Catalog} from './storage.mjs';
import {createBackup,restoreBackup,verifyBackup} from './backup.mjs';
import {rebuildCatalog} from './rebuild.mjs';
import {diagnostics,clearPreviewCache} from './diagnostics.mjs';
function currentDirectory(){const initial=path.resolve(process.env.ASSETNEST_DATA||path.join(path.dirname(fileURLToPath(import.meta.url)),'data')),config=process.env.ASSETNEST_CONFIG||path.join(initial,'libraries.json');return fs.existsSync(config)?JSON.parse(fs.readFileSync(config,'utf8')).current:initial;}
const [action,arg,target]=process.argv.slice(2);let catalog;
try{
 let result;
 if(action==='restore'){if(!arg||!target)throw Error('用法：node maintenance.mjs restore 备份目录 新的空目录');result=restoreBackup(arg,target);}
 else if(action==='rebuild'){if(!arg||!target)throw Error('用法：node maintenance.mjs rebuild 原素材库 新的空目录');result=rebuildCatalog(arg,target);}
 else if(action==='verify-backup'){if(!arg)throw Error('请提供备份目录');result=verifyBackup(arg);}
 else if(['check','backup','diagnose','clear-cache'].includes(action)){catalog=new Catalog(path.resolve(arg||currentDirectory()));result=action==='check'?catalog.integrity():action==='backup'?createBackup(catalog):action==='diagnose'?diagnostics(catalog):clearPreviewCache(catalog);if(action==='check'&&!result.healthy)process.exitCode=1;}
 else throw Error('用法：node maintenance.mjs check|backup|diagnose|clear-cache [素材库目录]，或 verify-backup 备份目录，或 restore|rebuild 来源目录 新的空目录');
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}finally{catalog?.close();}
