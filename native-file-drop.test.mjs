import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const csc=path.join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
test('Windows FileDrop preserves Unicode, long names and equal basenames; rejects missing and overlong paths as a whole',{skip:process.platform!=='win32'||!fs.existsSync(csc)},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assetnest-filedrop-')),name='中文 空格 & '+ 'long-name-'.repeat(9)+'.png';
 try{
  for(const directory of ['one','two']){fs.mkdirSync(path.join(temp,directory));fs.writeFileSync(path.join(temp,directory,name),'original-'+directory);}
  const source=path.join(temp,'Check.cs'),exe=path.join(temp,'Check.exe');
  fs.writeFileSync(source,`using System;using System.IO;using System.Windows.Forms;class Check {
   static void Assert(bool value,string message){if(!value)throw new Exception(message);}
   [STAThread]static void Main(string[] args){string a=args[0],b=args[1],root=args[2];
    string[] paths=NativeFileDrag.ValidateFiles(new object[]{a,b,a});Assert(paths.Length==2,"dedup");Assert(paths[0]==a&&paths[1]==b,"names preserved");
    var data=NativeFileDrag.CreateData(paths);Assert(data.GetDataPresent(DataFormats.FileDrop),"FileDrop missing");var read=(string[])data.GetData(DataFormats.FileDrop);Assert(read.Length==2&&read[0]==a&&read[1]==b,"Unicode or same basenames lost");
    var preferred=(MemoryStream)data.GetData("Preferred DropEffect");Assert(BitConverter.ToInt32(preferred.ToArray(),0)==1,"not copy only");
    bool missing=false;try{NativeFileDrag.ValidateFiles(new object[]{a,Path.Combine(root,"missing.png")});}catch(Exception e){missing=e.Message.Contains("2");}Assert(missing,"missing file not rejected");
    bool tooLong=false;try{NativeFileDrag.ValidateFiles(new object[]{a,Path.Combine(root,new string('x',290)+".png")});}catch(Exception){tooLong=true;}Assert(tooLong,"overlong path not rejected");
    bool relative=false;try{NativeFileDrag.ValidateFiles(new object[]{"relative.png"});}catch(Exception){relative=true;}Assert(relative,"relative path accepted");
    Assert(File.ReadAllText(a)=="original-one"&&File.ReadAllText(b)=="original-two","originals changed");Console.WriteLine("FileDrop, Unicode, long names, duplicate basenames, copy effect and atomic validation OK");
   }}
  `);
  const build=spawnSync(csc,['/nologo','/target:exe','/platform:x64','/r:System.Windows.Forms.dll','/out:'+exe,path.resolve('desktop/NativeFileDrag.cs'),source],{encoding:'utf8',windowsHide:true});assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(exe,[path.join(temp,'one',name),path.join(temp,'two',name),temp],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/atomic validation OK/);
 }finally{if(path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('assetnest-filedrop-'))fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
