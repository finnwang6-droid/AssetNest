import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {zipSync,unzipSync} from 'fflate';
const root=path.resolve(import.meta.dirname,'..'),release=path.join(root,'releases'),build=path.join(root,'test-output/desktop-build');fs.mkdirSync(build,{recursive:true});fs.mkdirSync(release,{recursive:true});
const runtime=path.join(root,'runtime/node.exe'),expected=fs.readFileSync(path.join(root,'runtime/SHASUMS256.txt'),'utf8').split(/\r?\n/).find(l=>l.endsWith(' win-x64/node.exe')).split(/\s+/)[0];
if(crypto.createHash('sha256').update(fs.readFileSync(runtime)).digest('hex')!==expected)throw Error('Bundled Node checksum mismatch');
const csc='C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
function compile(source,out,extras=[]){const r=spawnSync(csc,['/nologo','/win32icon:'+path.join(root,'assets/assetnest.ico'),'/target:winexe','/platform:x64','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll','/r:Microsoft.CSharp.dll',...extras.filter(x=>!x.endsWith('.cs')),'/out:'+out,path.join(root,'desktop',source),...extras.filter(x=>x.endsWith('.cs'))],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stdout+r.stderr);}
const webview=path.join(root,'desktop/webview2-sdk/1.0.4258.31'),webviewPackage=path.join(webview,'microsoft.web.webview2.1.0.4258.31.nupkg');
if(crypto.createHash('sha256').update(fs.readFileSync(webviewPackage)).digest('hex')!=='56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9')throw Error('WebView2 SDK checksum mismatch');
const webviewLib=path.join(webview,'package/lib/net462'),sdkFiles=unzipSync(fs.readFileSync(webviewPackage));
for(const relative of ['lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt','NOTICE.txt'])if(!fs.readFileSync(path.join(webview,'package',relative)).equals(Buffer.from(sdkFiles[relative])))throw Error('Extracted WebView2 file differs from verified package: '+relative);
compile('Launcher.cs',path.join(build,'AssetNest.exe'),['/r:'+path.join(webviewLib,'Microsoft.Web.WebView2.Core.dll'),'/r:'+path.join(webviewLib,'Microsoft.Web.WebView2.WinForms.dll'),path.join(root,'desktop/NativeWindow.cs'),path.join(root,'desktop/NativeFileDrag.cs')]);
compile('FolderPicker.cs',path.join(build,'FolderPicker.exe'),['/target:exe']);
fs.mkdirSync(path.join(root,'desktop/bin'),{recursive:true});fs.copyFileSync(path.join(build,'FolderPicker.exe'),path.join(root,'desktop/bin/FolderPicker.exe'));
const files={};const add=(key,file)=>files[key]=fs.readFileSync(file);
for(const name of ['organization-jobs.mjs','pdf-thumbnail.mjs','property-fields.mjs','watch-folders.mjs','maintenance-jobs.mjs','maintenance-worker.mjs','trash.mjs','server.mjs','desktop-actions.mjs','file-payload.mjs','zip-stream.mjs','transfers.mjs','diagnostics.mjs','formats.mjs','preview-tasks.mjs','thumbnail-worker.mjs','psd-preview.mjs','psd-worker.mjs','local-layout.mjs','storage.mjs','organize.mjs','search.mjs','features.mjs','libraries.mjs','eagle-library.mjs','eagle-pack.mjs','backup.mjs','capture-input.mjs','maintenance.mjs','rebuild.mjs','package.json'])add('app/'+name,path.join(root,name));
function directory(prefix,dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())directory(prefix+'/'+entry.name,full);else if(entry.isFile())add(prefix+'/'+entry.name,full);}}
directory('app/public',path.join(root,'public'));directory('app/extension',path.join(root,'extension'));
// Resolve each package from its parent so npm and pnpm installations both work.
const bundled=new Map();
function bundlePackage(name,parent,optional=false){
 const require=createRequire(parent);
 const candidate=(require.resolve.paths(name)||[]).map(dir=>path.join(dir,name,'package.json')).find(file=>fs.existsSync(file));
 if(!candidate){if(optional)return;throw Error('Required dependency not installed: '+name);}
 const manifest=fs.realpathSync(candidate);
 const meta=JSON.parse(fs.readFileSync(manifest));if(bundled.has(name)){if(bundled.get(name)!==meta.version)throw Error('Conflicting dependency versions: '+name);return;}
 bundled.set(name,meta.version);directory('app/node_modules/'+name,path.dirname(manifest));
 for(const dependency of Object.keys(meta.dependencies||{}))bundlePackage(dependency,manifest);
 for(const dependency of Object.keys(meta.optionalDependencies||{}))bundlePackage(dependency,manifest,true);
}
for(const name of ['fflate','sharp','ag-psd'])bundlePackage(name,path.join(root,'package.json'));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','README.md'])add(name,path.join(root,name));
add('docs/AUTHENTICATION.md',path.join(root,'docs/AUTHENTICATION.md'));
add('app/FolderPicker.exe',path.join(build,'FolderPicker.exe'));add('assetnest.ico',path.join(root,'assets/assetnest.ico'));add('AssetNest.exe',path.join(build,'AssetNest.exe'));add('Uninstall.ps1',path.join(root,'desktop/Uninstall.ps1'));add('runtime/node.exe',runtime);add('runtime/NODE-LICENSE.txt',path.join(root,'runtime/NODE-LICENSE.txt'));add('runtime/SHASUMS256.txt',path.join(root,'runtime/SHASUMS256.txt'));
add('Microsoft.Web.WebView2.Core.dll',path.join(webviewLib,'Microsoft.Web.WebView2.Core.dll'));add('Microsoft.Web.WebView2.WinForms.dll',path.join(webviewLib,'Microsoft.Web.WebView2.WinForms.dll'));add('WebView2Loader.dll',path.join(webview,'package/runtimes/win-x64/native/WebView2Loader.dll'));add('WEBVIEW2-LICENSE.txt',path.join(webview,'package/LICENSE.txt'));add('WEBVIEW2-NOTICE.txt',path.join(webview,'package/NOTICE.txt'));
files['assetnest-install.json']=Buffer.from(JSON.stringify({name:'AssetNest',version:'0.12.0',webview2:{sdk:'1.0.4258.31',packageSha256:'56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9',runtime:'system-evergreen'},files:[...Object.keys(files),'assetnest-install.json'],runtime:{version:'v24.19.0',sha256:expected,source:'https://nodejs.org/dist/v24.19.0/win-x64/node.exe'}},null,2));
const payload=path.join(build,'payload.zip');fs.writeFileSync(payload,zipSync(files,{level:6}));const setup=path.join(release,'AssetNest-Setup-0.12.0.exe');compile('Setup.cs',setup,['/r:System.Management.dll','/resource:'+payload+',payload.zip']);fs.writeFileSync(path.join(release,'AssetNest-Setup-0.12.0.sha256'),crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex')+'  AssetNest-Setup-0.12.0.exe\n');console.log(JSON.stringify({setup,bytes:fs.statSync(setup).size,files:Object.keys(files).length,nodeSha256:expected}));
