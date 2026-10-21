using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using System.Diagnostics;
using Microsoft.Win32;
using System.Management;
using System.Text.RegularExpressions;

class Setup {
 static void StopInstalled(string target){
  string exe=Path.Combine(target,"AssetNest.exe");
  foreach(var running in Process.GetProcessesByName("AssetNest")){using(running){
   string executable;try{executable=running.MainModule.FileName;}catch{continue;}
   if(!String.Equals(Path.GetFullPath(executable),exe,StringComparison.OrdinalIgnoreCase))continue;
   string command;try{using(var process=new ManagementObject("Win32_Process.Handle='"+running.Id+"'")){process.Get();command=(string)process["CommandLine"];}}catch{if(running.HasExited)continue;throw new Exception("无法识别当前安装的运行实例，请先退出拾素材再升级。");}
   var match=Regex.Match(command??"",@"/port=(\d+)",RegexOptions.IgnoreCase);int port=match.Success?int.Parse(match.Groups[1].Value):41600;if(port<1024||port>65535)throw new Exception("运行实例的端口无效，请先退出后再升级。");
   using(var signal=Process.Start(new ProcessStartInfo(exe,"/stop /port="+port){UseShellExecute=false,CreateNoWindow=true})){if(!signal.WaitForExit(5000))throw new Exception("退出信号发送超时，请先退出拾素材。");}
   if(!running.WaitForExit(10000))throw new Exception("拾素材仍在退出，请等待任务结束后重试安装。");
  }}
 }
 static void Cleanup(string directory){for(int attempt=0;attempt<3;attempt++){try{if(Directory.Exists(directory))Directory.Delete(directory,true);return;}catch(IOException){System.Threading.Thread.Sleep(200);}catch(UnauthorizedAccessException){System.Threading.Thread.Sleep(200);}}Console.Error.WriteLine("旧程序文件暂时占用，已保留目录："+directory);}
 static string Arg(string[] args,string name,string fallback){foreach(string arg in args)if(arg.StartsWith(name+"=",StringComparison.OrdinalIgnoreCase))return arg.Substring(name.Length+1);return fallback;}
 static void Shortcut(string location,string target){Type t=Type.GetTypeFromProgID("WScript.Shell");dynamic shell=Activator.CreateInstance(t);dynamic shortcut=shell.CreateShortcut(location);shortcut.TargetPath=target;shortcut.IconLocation=target+",0";shortcut.WorkingDirectory=Path.GetDirectoryName(target);shortcut.Save();}
 [STAThread] static int Main(string[] args){
  bool silent=Array.Exists(args,a=>a=="/silent"),shortcuts=!Array.Exists(args,a=>a=="/no-shortcuts");string target=Path.GetFullPath(Arg(args,"/dir",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","AssetNest"))),stage=null;
  try{
   if(!silent&&MessageBox.Show("安装拾素材 0.11.0 到：\n"+target+"\n\n升级保留素材库和启动配置。","拾素材安装",MessageBoxButtons.OKCancel)!=DialogResult.OK)return 0;
   if(Directory.Exists(target)&&!File.Exists(Path.Combine(target,"assetnest-install.json"))&&Directory.GetFileSystemEntries(target).Length>0)throw new Exception("安装目标不是已有拾素材安装或空目录，不覆盖其他文件。");
   if(Directory.Exists(target)&&File.Exists(Path.Combine(target,"AssetNest.exe")))StopInstalled(target);
   stage=target+".stage-"+Guid.NewGuid().ToString("N");Directory.CreateDirectory(stage);
   using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))using(var archive=new ZipArchive(stream,ZipArchiveMode.Read))foreach(var entry in archive.Entries){string output=Path.GetFullPath(Path.Combine(stage,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));if(!output.StartsWith(stage+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("安装包路径无效");Directory.CreateDirectory(Path.GetDirectoryName(output));entry.ExtractToFile(output);}
   // Existing executable files are backed up before publishing. User data is outside this manifest.
   Directory.CreateDirectory(target);string rollback=stage+".rollback";Directory.CreateDirectory(rollback);var published=new System.Collections.Generic.List<string>();
   try{foreach(string file in Directory.GetFiles(stage,"*",SearchOption.AllDirectories)){string relative=file.Substring(stage.Length+1),dest=Path.Combine(target,relative),old=Path.Combine(rollback,relative);Directory.CreateDirectory(Path.GetDirectoryName(dest));if(File.Exists(dest)){Directory.CreateDirectory(Path.GetDirectoryName(old));File.Move(dest,old);}published.Add(relative);File.Move(file,dest);}}
   catch{published.Reverse();foreach(string relative in published){string dest=Path.Combine(target,relative),old=Path.Combine(rollback,relative);if(File.Exists(dest))File.Delete(dest);if(File.Exists(old))File.Move(old,dest);}throw;}
   finally{Cleanup(rollback);}
   string config=Path.Combine(target,"default-data.txt");if(!File.Exists(config)){string data=Path.GetFullPath(Arg(args,"/data",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AssetNest","Libraries","Main")));File.WriteAllText(config,data);}
   if(shortcuts){string exe=Path.Combine(target,"AssetNest.exe"),menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"拾素材");Directory.CreateDirectory(menu);Shortcut(Path.Combine(menu,"拾素材.lnk"),exe);Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"拾素材.lnk"),exe);using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\AssetNest")){key.SetValue("DisplayName","拾素材 AssetNest");key.SetValue("DisplayVersion","0.11.0");key.SetValue("InstallLocation",target);key.SetValue("UninstallString","powershell.exe -NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(target,"Uninstall.ps1")+"\"");key.SetValue("NoModify",1);key.SetValue("NoRepair",1);}}
   if(!silent){MessageBox.Show("安装完成。启动后可在「切换 / 管理素材库」添加已有拾素材库；不会自动搬移或删除旧库。","拾素材");Process.Start(Path.Combine(target,"AssetNest.exe"));}return 0;
  }catch(Exception e){if(!silent)MessageBox.Show(e.Message,"安装失败");else Console.Error.WriteLine(e.Message);return 1;}
  finally{if(stage!=null&&Directory.Exists(stage))Cleanup(stage);}
 }
}
