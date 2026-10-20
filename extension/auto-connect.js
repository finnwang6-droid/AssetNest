import {captureError} from './capture-error.js';
const pending=new Map();
export function localServer(value='http://127.0.0.1:41600'){
 let u;try{u=new URL(value);}catch{throw captureError('CONFIG_REQUIRED','本地服务地址无效',{pause:true});}
 if(!['127.0.0.1','localhost'].includes(u.hostname)||u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw captureError('CONFIG_REQUIRED','自动连接仅支持配置的本机 HTTP 地址',{pause:true});return u.origin;
}
export function autoConnect(server,{browser=globalThis.chrome,request=globalThis.fetch}={}){
 server=localServer(server);if(pending.has(server))return pending.get(server);
 const operation=pair(server,browser,request).finally(()=>pending.delete(server));pending.set(server,operation);return operation;
}
async function pair(server,browser,request){
 let health;try{const r=await request(server+'/api/health',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();health=await r.json();}catch{throw captureError('SERVICE_UNAVAILABLE','未找到本机拾素材，请先启动软件；打开插件时会自动连接',{retryable:true});}
 if(health.name!=='AssetNest'||!health.libraryId)throw captureError('CONFIG_REQUIRED','配置的本机地址不是拾素材服务',{pause:true});
 if(health.storageConfigured===false)throw captureError('CONFIG_REQUIRED','请先在拾素材软件中选择素材库保存位置，再打开插件自动连接',{pause:true});
 // Bootstrap stays same-origin only. Use a temporary local app tab, never a remote site or a key in a URL.
 let tab;try{
  tab=await browser.tabs.create({url:server+'/?assetnest-pair=1',active:false});
  await new Promise((resolve,reject)=>{let timer;const cleanup=()=>{clearTimeout(timer);browser.tabs.onUpdated.removeListener(listener);};const listener=(id,change)=>{if(id===tab.id&&change.status==='complete'){cleanup();resolve();}};browser.tabs.onUpdated.addListener(listener);timer=setTimeout(()=>{cleanup();reject(Error('本机连接页面加载超时'));},10000);browser.tabs.get(tab.id).then(t=>{if(t.status==='complete'){cleanup();resolve();}},e=>{cleanup();reject(e);});});
  const result=await browser.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:async expected=>{if(location.origin!==expected)throw Error('连接页面地址变化');const r=await fetch('/api/bootstrap',{credentials:'omit',cache:'no-store'});if(!r.ok)throw Error('本机连接信息读取失败');const j=await r.json();return {key:j.key,libraryId:j.libraryId,port:j.port};},args:[server]});
  const info=result[0]?.result;if(!/^[0-9a-f]{64}$/i.test(info?.key||'')||info.libraryId!==health.libraryId||Number(info.port)!==Number(new URL(server).port||80))throw Error('本机连接信息未通过校验');
  await browser.storage.local.set({server,key:info.key,autoConnect:true,autoConnectedAt:Date.now(),connectedLibrary:{server,libraryId:info.libraryId}});return {server,key:info.key};
 }catch(e){if(e.code)throw e;throw captureError('PAIR_FAILED','自动连接未完成：'+e.message+'。可在设置中手动填写密钥',{pause:true});}
 finally{if(tab?.id!==undefined)try{await browser.tabs.remove(tab.id);}catch{}}
}
