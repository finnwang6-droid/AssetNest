using System;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Text;

class Launcher : Form {
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
 [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window,int id);
 static string root=AppDomain.CurrentDomain.BaseDirectory;
 string data,url;int port;Process owned;NotifyIcon tray;EventWaitHandle showEvent,stopEvent;System.Windows.Forms.Timer timer;bool hotkey,explicitData,windowTesting;int windowDebugPort;NativeWindow nativeWindow;
 static string Arg(string[] args,string name,string fallback){foreach(string arg in args)if(arg.StartsWith(name+"=",StringComparison.OrdinalIgnoreCase))return arg.Substring(name.Length+1);return fallback;}
 static bool Flag(string[] args,string value){return Array.Exists(args,a=>a==value);}
 static string Read(string url){var request=(HttpWebRequest)WebRequest.Create(url);request.Timeout=1500;using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))return reader.ReadToEnd();}
 bool Health(){try{var j=new JavaScriptSerializer().DeserializeObject(Read(url+"/api/health")) as System.Collections.Generic.Dictionary<string,object>;Version version;return (string)j["name"]=="AssetNest"&&Version.TryParse((string)j["version"],out version)&&version.Major==0&&version>=new Version(0,8,1);}catch{return false;}}
 bool EmptyLibrary(){string images=Path.Combine(data,"images");return !Directory.Exists(images)||Directory.GetFileSystemEntries(images).Length==0;}
 void AttachExisting(){
  var j=new JavaScriptSerializer().DeserializeObject(Read(url+"/api/bootstrap")) as System.Collections.Generic.Dictionary<string,object>;string keyFile=Path.Combine(data,"connection-key");if(File.Exists(keyFile)&&(string)j["key"]==File.ReadAllText(keyFile).Trim())return;
  if(!explicitData&&EmptyLibrary()){
   string existing=Path.GetFullPath((string)(j.ContainsKey("startupDataPath")?j["startupDataPath"]:j["dataPath"]));string existingKey=Path.Combine(existing,"connection-key");if(!File.Exists(existingKey)||File.ReadAllText(existingKey).Trim()!=(string)j["key"])throw new Exception("运行中的素材库身份无法核对，请在浏览器打开 "+url+" 查看。");
   string config=Path.Combine(root,"default-data.txt");if(File.Exists(config))File.Copy(config,config+".before-adopt-"+DateTime.Now.ToString("yyyyMMddHHmmssfff"));string pending=config+".tmp";File.WriteAllText(pending,existing);if(File.Exists(config))File.Replace(pending,config,null);else File.Move(pending,config);data=existing;return;
  }
  throw new Exception("此端口正在运行另一个素材库，当前库不会被覆盖。请先打开 "+url+" 查看已有素材；如需启动指定的另一个库，请先退出运行中的服务。");
 }
 void StartService(){
  if(Health()){AttachExisting();return;}
  Directory.CreateDirectory(data);
  var info=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"),"\""+Path.Combine(root,"app","server.mjs")+"\"");info.WorkingDirectory=Path.Combine(root,"app");info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardError=true;info.RedirectStandardOutput=true;info.EnvironmentVariables["ASSETNEST_DATA"]=data;info.EnvironmentVariables["ASSETNEST_PORT"]=port.ToString();info.EnvironmentVariables["ASSETNEST_DESKTOP"]="1";info.EnvironmentVariables["ASSETNEST_REQUIRE_LOCATION"]="1";
  owned=new Process();owned.StartInfo=info;string log=Path.Combine(data,"desktop-server.log");owned.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)try{File.AppendAllText(log,e.Data+Environment.NewLine);}catch{}};owned.OutputDataReceived+=(s,e)=>{};owned.Start();owned.BeginErrorReadLine();owned.BeginOutputReadLine();
  for(int n=0;n<80;n++){if(Health())return;if(owned.HasExited)break;Thread.Sleep(100);}throw new Exception("本地服务启动失败，请查看 "+log+"。可能已有其他版本占用端口。");
 }
 void OpenWindow(){if(nativeWindow==null||nativeWindow.IsDisposed){string profile=windowTesting?Path.Combine(data,"webview2-test"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AssetNest","WebView2",port.ToString());string state=Path.Combine(profile,"window-state.json");nativeWindow=new NativeWindow(url,profile,state,windowTesting,windowDebugPort);}nativeWindow.Present();}
 void StopOwned(){if(owned==null)return;try{if(!owned.HasExited){var request=(HttpWebRequest)WebRequest.Create(url+"/api/shutdown");request.Method="POST";request.ContentLength=0;request.Timeout=3000;request.Headers.Add("X-Assetnest-Key",File.ReadAllText(Path.Combine(data,"connection-key")).Trim());using(var response=request.GetResponse()){}owned.WaitForExit(4000);}}catch{}finally{if(!owned.HasExited)try{owned.Kill();}catch{}owned.Dispose();owned=null;}}
 Launcher(string[] args){
  windowTesting=Flag(args,"/window-test");windowDebugPort=int.Parse(Arg(args,"/debug-port","0"));
  port=int.Parse(Arg(args,"/port","41600"));if(port<1024||port>65535)throw new Exception("端口无效");url="http://127.0.0.1:"+port;
  explicitData=Array.Exists(args,a=>a.StartsWith("/data=",StringComparison.OrdinalIgnoreCase));string defaultFile=Path.Combine(root,"default-data.txt");data=Path.GetFullPath(Arg(args,"/data",File.Exists(defaultFile)?File.ReadAllText(defaultFile).Trim():Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AssetNest","Libraries","Main")));
  try{StartService();}catch{StopOwned();throw;}if(Flag(args,"/probe")){Console.WriteLine("AssetNest 0.10.3 ready "+url);File.WriteAllText(Path.Combine(data,"launcher-probe.json"),"{\"version\":\"0.10.3\",\"ready\":true}");StopOwned();return;}
  ShowInTaskbar=false;WindowState=FormWindowState.Minimized;FormBorderStyle=FormBorderStyle.FixedToolWindow;Opacity=0;
  tray=new NotifyIcon();tray.Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);tray.Text="拾素材 0.10.3";tray.Visible=true;tray.DoubleClick+=(s,e)=>OpenWindow();var menu=new ContextMenuStrip();menu.Items.Add("打开拾素材",null,(s,e)=>OpenWindow());menu.Items.Add("打开启动素材库目录",null,(s,e)=>Process.Start("explorer.exe",data));menu.Items.Add("退出拾素材",null,(s,e)=>Quit());tray.ContextMenuStrip=menu;
  showEvent=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\AssetNest.Show."+port);stopEvent=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\AssetNest.Stop."+port);
  timer=new System.Windows.Forms.Timer();timer.Interval=250;timer.Tick+=(s,e)=>{if(showEvent.WaitOne(0))OpenWindow();if(stopEvent.WaitOne(0)){Quit();return;}};timer.Start();
  hotkey=RegisterHotKey(Handle,1,0x4003,0x20);if(!hotkey){tray.BalloonTipText="Ctrl+Alt+Space 已被其他程序占用，可双击托盘图标打开。";tray.ShowBalloonTip(3000);}File.WriteAllText(Path.Combine(data,"desktop-ready.json"),"{\"ready\":true,\"hotkeyRegistered\":"+(hotkey?"true":"false")+"}");if(!Flag(args,"/background"))OpenWindow();
 }
 protected override void SetVisibleCore(bool value){base.SetVisibleCore(false);}
 protected override void WndProc(ref Message m){if(m.Msg==0x0312&&m.WParam.ToInt32()==1)OpenWindow();base.WndProc(ref m);}
 void Quit(){if(nativeWindow!=null){nativeWindow.Shutdown();nativeWindow=null;}if(hotkey){UnregisterHotKey(Handle,1);hotkey=false;}if(timer!=null){timer.Dispose();timer=null;}if(tray!=null){tray.Visible=false;tray.Dispose();tray=null;}if(showEvent!=null){showEvent.Dispose();showEvent=null;}if(stopEvent!=null){stopEvent.Dispose();stopEvent=null;}StopOwned();Application.ExitThread();}
 protected override void OnFormClosed(FormClosedEventArgs e){Quit();base.OnFormClosed(e);}
 [STAThread] static int Main(string[] args){
  SetProcessDPIAware();Application.EnableVisualStyles();string port=Arg(args,"/port","41600");if(Flag(args,"/stop")){try{using(var ev=EventWaitHandle.OpenExisting("Local\\AssetNest.Stop."+port))ev.Set();return 0;}catch{return 1;}}
  bool first;using(var mutex=new Mutex(true,"Local\\AssetNest.Desktop."+port,out first)){if(!first){if(!Flag(args,"/background"))try{using(var ev=EventWaitHandle.OpenExisting("Local\\AssetNest.Show."+port))ev.Set();}catch{}return 0;}Launcher app=null;try{app=new Launcher(args);if(!Flag(args,"/probe"))Application.Run();return 0;}catch(Exception e){if(app!=null)app.StopOwned();try{File.AppendAllText(Path.Combine(root,"launcher-error.log"),e.ToString());}catch{}if(!Flag(args,"/probe")&&!Flag(args,"/background"))MessageBox.Show(e.Message,"拾素材",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}finally{if(app!=null)app.Dispose();mutex.ReleaseMutex();}}
 }
}
