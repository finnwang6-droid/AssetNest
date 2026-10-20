import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {zipSync,unzipSync} from 'fflate';

const root=path.resolve(import.meta.dirname,'..'),release=path.join(root,'releases');
const app=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),extension=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json')));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const installerName=`AssetNest-Setup-${app.version}.exe`,installer=fs.readFileSync(path.join(release,installerName));
assert.equal(hash(installer),fs.readFileSync(path.join(release,installerName.replace('.exe','.sha256')),'utf8').trim().split(/\s+/)[0]);
const extensionFiles={};
function collect(dir,prefix){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),key=prefix+'/'+entry.name;if(entry.isDirectory())collect(file,key);else if(entry.isFile())extensionFiles[key]=fs.readFileSync(file);else throw Error('Unexpected extension entry: '+file);}}
collect(path.join(root,'extension'),'assetnest-extension');
const extensionName=`assetnest-extension-${extension.version}.zip`,extensionZip=zipSync(extensionFiles,{level:6});
const instructions=`拾素材 AssetNest ${app.version}（Windows x64）

安装软件：双击 ${installerName}，首次启动选择素材库位置。
软件已包含 Node.js 运行环境；需要系统安装 Microsoft Edge WebView2 Runtime。
安装包尚未进行代码签名。请核对下载来源和 SHA-256。

安装浏览器扩展：解压后，在 Chrome / Edge 的扩展管理页面启用开发者模式，
选择“加载已解压的扩展程序”，加载 assetnest-extension 文件夹。
启动软件并选择素材库后，打开扩展即可自动配对。
浏览器扩展版本：${extension.version}。

直接读写 Eagle 素材库前，请先退出 Eagle 并备份原库。
本安装包不含私人素材、连接密钥或浏览器配置，使用与开源源码一致的自绘图标。
原创代码为 MIT 许可，第三方组件保留原许可，详见随包声明。
源码：https://github.com/finnwang6-droid/AssetNest
`;
const files={[installerName]:installer,...extensionFiles,[extensionName]:extensionZip,'安装说明.txt':Buffer.from('\uFEFF'+instructions)};
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])files[name]=fs.readFileSync(path.join(root,name));
files['SHA256SUMS.txt']=Buffer.from(Object.entries(files).map(([name,bytes])=>hash(bytes)+'  '+name).join('\n')+'\n');
const archiveName=`AssetNest-${app.version}-Windows-x64.zip`,archive=zipSync(files,{level:6}),unpacked=unzipSync(archive);
assert.deepEqual(Object.keys(unpacked).sort(),Object.keys(files).sort());for(const [name,bytes]of Object.entries(files))assert.equal(hash(unpacked[name]),hash(bytes),name);
fs.writeFileSync(path.join(release,archiveName),archive);fs.writeFileSync(path.join(release,extensionName),extensionZip);
fs.writeFileSync(path.join(release,'SHA256SUMS.txt'),[[installerName,installer],[extensionName,extensionZip],[archiveName,archive]].map(([name,bytes])=>hash(bytes)+'  '+name).join('\n')+'\n');
console.log(JSON.stringify({installer:installerName,extension:extensionName,bundle:archiveName,verified:true}));
