const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('assetnestDesktop',{host:'electron',platform:process.platform,fileDrag:false});
