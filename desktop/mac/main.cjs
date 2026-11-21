const {app,BrowserWindow,Menu,dialog,shell,globalShortcut}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
app.setName('AssetNest');app.setPath('userData',process.env.ASSETNEST_MAC_SMOKE==='1'&&process.env.ASSETNEST_DATA?path.join(process.env.ASSETNEST_DATA,'desktop-profile'):path.join(app.getPath('appData'),'AssetNest'));
let child,win,quitting=false;
const smoke=process.env.ASSETNEST_MAC_SMOKE==='1';
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
app.whenReady().then(start).catch(e=>{dialog.showErrorBox('拾素材启动失败',String(e));app.quit();});
}
async function availablePort(){for(let port=41600;port<41611;port++){if(await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));}))return port;}throw Error('本地端口 41600–41610 均被占用');}
async function start(){
 const root=app.isPackaged?path.join(process.resourcesPath,'service'):path.resolve(__dirname,'../..');
 const node=app.isPackaged?path.join(process.resourcesPath,'runtime/node'):process.env.ASSETNEST_NODE||'/usr/local/bin/node';
 const data=process.env.ASSETNEST_DATA||path.join(app.getPath('userData'),'library');fs.mkdirSync(data,{recursive:true});
 const port=await availablePort(),base=`http://127.0.0.1:${port}`;
 const log=fs.openSync(path.join(data,'desktop-server.log'),'a');
 child=spawn(node,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,ASSETNEST_DATA:data,ASSETNEST_CONFIG:path.join(data,'libraries.json'),ASSETNEST_PORT:String(port),ASSETNEST_DESKTOP:'1',ASSETNEST_REQUIRE_LOCATION:'0'},stdio:['ignore',log,log,'ipc']});fs.closeSync(log);
 child.on('message',message=>{if(message?.type==='assetnest-show'&&win){if(win.isMinimized())win.restore();win.show();app.focus({steal:true});win.focus();}});
 let failed;child.on('error',e=>{failed=e;});child.on('exit',code=>{failed=Error(`本地服务已退出 (${code})，请查看 ${path.join(data,'desktop-server.log')}`);if(win&&!quitting){dialog.showErrorBox('本地服务停止',failed.message);app.quit();}});
 let ready=false;for(let n=0;n<200;n++){if(failed)throw failed;try{const r=await fetch(base+'/api/health');if(r.ok&&(await r.json()).name==='AssetNest'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('本地服务启动超时');
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'拾素材',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'显示',submenu:[{role:'reload'},{role:'togglefullscreen'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}]));
 win=new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:650,title:'拾素材 · AssetNest',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))void shell.openExternal(url);return {action:'deny'};});
 win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==base){e.preventDefault();if(/^https?:/.test(url))void shell.openExternal(url);}});
 win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});
 await win.loadURL(base);win.show();
 globalShortcut.register('CommandOrControl+Alt+Space',()=>{win.show();win.focus();});
 if(smoke){if(process.env.ASSETNEST_MAC_SHOW_TEST==='1'){win.hide();const boot=await(await fetch(base+'/api/bootstrap')).json();const response=await fetch(base+'/api/desktop/show',{method:'POST',headers:{'X-Assetnest-Key':boot.key,Origin:'chrome-extension://assetnest-test'}});await new Promise(r=>setTimeout(r,300));if(!response.ok||!win.isVisible())throw Error('通知唤起窗口检查失败');fs.writeFileSync(path.join(data,'mac-show-test.json'),JSON.stringify({status:response.status,visible:win.isVisible(),focused:win.isFocused()}));}await new Promise(r=>setTimeout(r,1800));if(process.env.ASSETNEST_MAC_LIBRARY_TEST==='1'){await win.webContents.executeJavaScript(`(async()=>{document.querySelector('#library-switch-trigger').click();await new Promise(r=>setTimeout(r,500));document.querySelector('#new-library').click();const f=document.querySelector('#library-dialog form');f.elements.path.value='/Volumes/D';f.elements.name.value='日常';f.elements.name.dispatchEvent(new Event('input'));})()`);}
 const result=await win.webContents.executeJavaScript(`JSON.stringify({title:document.title,host:window.assetnestDesktop?.host,platform:window.assetnestDesktop?.platform,body:document.body.innerText.slice(0,3000)})`);fs.writeFileSync(path.join(data,'mac-smoke.json'),result);win.capturePage().then(image=>{fs.writeFileSync(path.join(data,'mac-smoke.png'),image.toPNG());app.quit();});}
}
app.on('activate',()=>{if(win){win.show();win.focus();}});
app.on('before-quit',()=>{quitting=true;globalShortcut.unregisterAll();if(child&&!child.killed)child.kill('SIGTERM');});
