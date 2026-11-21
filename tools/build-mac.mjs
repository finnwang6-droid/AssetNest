import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {zipSync} from 'fflate';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='darwin')throw Error('请在 macOS 上构建');
const stage=path.join(root,'test-output/mac-build');if(process.env.ASSETNEST_REUSE_STAGE!=='1')fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(path.join(stage,'service'),{recursive:true});fs.mkdirSync(path.join(stage,'runtime'),{recursive:true});
for(const f of fs.readdirSync(root)){if(f.endsWith('.mjs')&&!f.endsWith('.test.mjs')&&f!=='test.mjs'||f==='package.json')fs.copyFileSync(path.join(root,f),path.join(stage,'service',f));}
for(const dir of ['public','extension'])fs.cpSync(path.join(root,dir),path.join(stage,'service',dir),{recursive:true});
if(process.env.ASSETNEST_REUSE_STAGE!=='1'){
// npm installs the host-platform sharp binaries; keep this service separate from Electron's ABI.
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
for(const [relative,meta] of Object.entries(lock.packages)){if(!relative||meta.dev)continue;const source=path.join(root,relative);if(fs.existsSync(source))fs.cpSync(source,path.join(stage,'service',relative),{recursive:true});}
fs.copyFileSync(process.execPath,path.join(stage,'runtime/node'));fs.chmodSync(path.join(stage,'runtime/node'),0o755);
}
for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])fs.copyFileSync(path.join(root,file),path.join(stage,file));
const icons=path.join(stage,'AssetNest.iconset');fs.mkdirSync(icons,{recursive:true});for(const size of [16,32,128,256,512])for(const scale of [1,2]){const result=spawnSync('sips',['-z',String(size*scale),String(size*scale),path.join(root,'assets/icon-256.png'),'--out',path.join(icons,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});if(result.status)throw Error('图标生成失败');}
if(spawnSync('iconutil',['-c','icns',icons,'-o',path.join(stage,'AssetNest.icns')]).status)throw Error('icns 生成失败');
const extensionFiles={};
function collectExtension(dir,relative=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=path.posix.join(relative,entry.name);if(entry.isDirectory())collectExtension(path.join(dir,entry.name),name);else if(entry.isFile())extensionFiles['assetnest-extension/'+name]=fs.readFileSync(path.join(dir,entry.name));}}
collectExtension(path.join(root,'extension'));const extensionVersion=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'))).version;fs.mkdirSync(path.join(root,'releases'),{recursive:true});fs.writeFileSync(path.join(root,'releases',`assetnest-extension-${extensionVersion}.zip`),zipSync(extensionFiles));
const {build,Platform,Arch}=await import('electron-builder');
await build({targets:Platform.MAC.createTarget(['dmg','zip'],process.arch==='arm64'?Arch.arm64:Arch.x64),config:{appId:'com.assetnest.desktop',productName:'AssetNest',directories:{output:'releases'},files:['desktop/mac/**','package.json','!node_modules/**/*'],extraResources:[{from:path.join(stage,'service'),to:'service'},{from:path.join(stage,'runtime'),to:'runtime'},{from:path.join(stage,'LICENSE'),to:'LICENSE'},{from:path.join(stage,'THIRD_PARTY_NOTICES.md'),to:'THIRD_PARTY_NOTICES.md'}],asar:true,npmRebuild:false,afterPack:async context=>{
 const service=path.join(context.appOutDir,'AssetNest.app/Contents/Resources/service');
 // extraResources applies electron-builder's node_modules exclusions: copy explicitly after packing.
 fs.cpSync(path.join(stage,'service/node_modules'),path.join(service,'node_modules'),{recursive:true});
 const {createRequire}=await import('node:module');const require=createRequire(path.join(service,'package.json'));
 for(const name of ['sharp','fflate','ag-psd']){const resolved=require.resolve(name);if(!resolved.startsWith(service+path.sep))throw Error('Missing bundled dependency: '+name);}
 const checked=spawnSync(path.join(context.appOutDir,'AssetNest.app/Contents/Resources/runtime/node'),['--input-type=module','-e',"await import('sharp');await import('fflate');await import('ag-psd');"],{cwd:service,encoding:'utf8'});if(checked.status!==0)throw Error('Bundled dependency check failed: '+checked.stderr);
 },mac:{icon:path.join(stage,'AssetNest.icns'),category:'public.app-category.graphics-design',identity:null,artifactName:'AssetNest-${version}-mac-${arch}.${ext}'},dmg:{title:'安装 AssetNest'}}});
const files=fs.readdirSync(path.join(root,'releases')).filter(f=>/\.(dmg|zip)$/.test(f));fs.writeFileSync(path.join(root,'releases/SHA256SUMS-mac.txt'),files.map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'releases',f))).digest('hex')+'  '+f).join('\n')+'\n');
