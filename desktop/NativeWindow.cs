using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// The app owns its window and embedded renderer. External websites are opened
// only after an explicit user navigation, never inside the privileged app view.
class NativeWindow : Form {
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
 readonly string home,profile,stateFile;readonly bool testing;readonly int debugPort;WebView2 view;Label status;bool initialized,terminating;readonly JavaScriptSerializer json=new JavaScriptSerializer();
 bool fileDragging,cancelFileDrag;string activeDragToken;
 public NativeWindow(string home,string profile,string stateFile,bool testing=false,int debugPort=0){
  this.home=home;this.profile=profile;this.stateFile=stateFile;this.testing=testing;this.debugPort=debugPort;json.MaxJsonLength=2*1024*1024;
  Text="拾素材 · AssetNest";Name="AssetNestNativeWindow";BackColor=Color.FromArgb(32,33,35);ForeColor=Color.Gainsboro;Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);AutoScaleMode=AutoScaleMode.Dpi;MinimumSize=new Size(820,580);ClientSize=new Size(1320,820);StartPosition=FormStartPosition.CenterScreen;
  try{if(File.Exists(stateFile)){var saved=json.DeserializeObject(File.ReadAllText(stateFile)) as System.Collections.Generic.Dictionary<string,object>;var bounds=new Rectangle(Convert.ToInt32(saved["x"]),Convert.ToInt32(saved["y"]),Math.Max(820,Convert.ToInt32(saved["width"])),Math.Max(580,Convert.ToInt32(saved["height"])));if(Array.Exists(Screen.AllScreens,s=>s.WorkingArea.IntersectsWith(bounds))){StartPosition=FormStartPosition.Manual;Bounds=bounds;}if(saved.ContainsKey("maximized")&&(bool)saved["maximized"])WindowState=FormWindowState.Maximized;}}catch{}
  status=new Label{Text="正在打开素材库…",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,ForeColor=Color.Gainsboro};Controls.Add(status);Shown+=(s,e)=>Initialize();VisibleChanged+=(s,e)=>ScheduleProbe();Resize+=(s,e)=>ScheduleProbe();FormClosing+=(s,e)=>{SaveState();if(!terminating){e.Cancel=true;Hide();}};
 }
 protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);ApplyTheme();}
 public void ApplyTheme(){try{int dark=1,caption=0x232120,text=0xdddddd;DwmSetWindowAttribute(Handle,20,ref dark,4);DwmSetWindowAttribute(Handle,19,ref dark,4);DwmSetWindowAttribute(Handle,35,ref caption,4);DwmSetWindowAttribute(Handle,36,ref text,4);}catch{}}
 void ProbeState(){if(!testing)return;try{Directory.CreateDirectory(profile);File.WriteAllText(Path.Combine(profile,"native-window-state.json"),json.Serialize(new{visible=Visible,windowsVisible=IsHandleCreated&&IsWindowVisible(Handle),state=WindowState.ToString(),processId=Process.GetCurrentProcess().Id}));}catch{}}
 void ScheduleProbe(){if(!testing||!IsHandleCreated||IsDisposed)return;BeginInvoke(new Action(()=>{if(!IsDisposed)ProbeState();}));}
 void SaveState(){try{var r=WindowState==FormWindowState.Normal?Bounds:RestoreBounds;Directory.CreateDirectory(Path.GetDirectoryName(stateFile));File.WriteAllText(stateFile,json.Serialize(new{x=r.X,y=r.Y,width=r.Width,height=r.Height,maximized=WindowState==FormWindowState.Maximized}));}catch{}}
 bool Own(string value){Uri uri,origin;if(!Uri.TryCreate(value,UriKind.Absolute,out uri)||!Uri.TryCreate(home,UriKind.Absolute,out origin))return false;return uri.Scheme==origin.Scheme&&uri.Host==origin.Host&&uri.Port==origin.Port&&String.IsNullOrEmpty(uri.UserInfo);}
 void External(string value){Uri uri;if(Uri.TryCreate(value,UriKind.Absolute,out uri)&&(uri.Scheme=="http"||uri.Scheme=="https")&&String.IsNullOrEmpty(uri.UserInfo))Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});}
 Dictionary<string,object> LocalJson(string route,string body=null,string key=null,string library=null){
  var serializer=new JavaScriptSerializer{MaxJsonLength=2*1024*1024};
  var request=(HttpWebRequest)WebRequest.Create(home+route);request.Timeout=5000;request.ReadWriteTimeout=5000;request.Proxy=null;
  if(key!=null)request.Headers.Add("X-Assetnest-Key",key);if(library!=null)request.Headers.Add("X-Assetnest-Library",library);
  if(body!=null){request.Method="POST";request.ContentType="application/json";byte[] bytes=Encoding.UTF8.GetBytes(body);request.ContentLength=bytes.Length;using(var stream=request.GetRequestStream())stream.Write(bytes,0,bytes.Length);}
  try{using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))return serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string,object>;}
  catch(WebException e){if(e.Response!=null)using(var reader=new StreamReader(e.Response.GetResponseStream())){var failure=serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string,object>;if(failure!=null&&failure.ContainsKey("error"))throw new Exception(Convert.ToString(failure["error"]));}throw;}
 }
 void DragMessage(string kind,string token,bool cancelled=false,string error=null,string result=null,int count=0){
  if(view==null||view.IsDisposed||view.CoreWebView2==null)return;Point screen=Cursor.Position,p=view.PointToClient(screen);IntPtr hit=WindowFromPoint(screen);bool own=hit==view.Handle||IsChild(view.Handle,hit);
  try{view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new{type=kind,token,x=p.X,y=p.Y,width=view.ClientSize.Width,height=view.ClientSize.Height,atSource=own&&view.ClientRectangle.Contains(p),cancelled,error,result,count}));}catch{}
 }
 async void DragFiles(Dictionary<string,object> message){
  string token=message.ContainsKey("token")?Convert.ToString(message["token"]):"";bool released=false,cancelled=false,previousDrop=true,changedDrop=false;string outcome="cancelled",failure=null;int count=0;System.Windows.Forms.Timer timer=null;QueryContinueDragEventHandler query=null;
  try{
   if(view==null||view.IsDisposed||terminating)throw new Exception("客户端已关闭");
   var ids=message.ContainsKey("ids")?message["ids"] as object[]:null;string library=message.ContainsKey("libraryId")?Convert.ToString(message["libraryId"]):"";
   Guid parsed;if(!Guid.TryParse(token,out parsed)||ids==null||ids.Length==0||ids.Length>500||String.IsNullOrEmpty(library))throw new Exception("拖拽素材参数无效");
   DragMessage("native-drag-preparing",token,false,null,null,ids.Length);
   string body=json.Serialize(new{ids});
   var paths=await Task.Run(()=>{var bootstrap=LocalJson("/api/bootstrap");var result=LocalJson("/api/desktop/drag-files",body,Convert.ToString(bootstrap["key"]),library);return NativeFileDrag.ValidateFiles(result["files"] as object[]);});
   count=paths.Length;
   if(cancelFileDrag||terminating||view==null||view.IsDisposed)throw new OperationCanceledException();
   if((Control.MouseButtons&MouseButtons.Left)==0){outcome="released-before-ready";throw new OperationCanceledException();}
   var data=NativeFileDrag.CreateData(paths);
   previousDrop=view.AllowExternalDrop;view.AllowExternalDrop=false;changedDrop=true;
   query=(s,e)=>{if(e.EscapePressed||cancelFileDrag||terminating){cancelled=true;e.Action=DragAction.Cancel;}else if((e.KeyState&1)==0){released=true;e.Action=DragAction.Drop;}};QueryContinueDrag+=query;
   timer=new System.Windows.Forms.Timer{Interval=75};timer.Tick+=(s,e)=>DragMessage("native-drag-over",token);timer.Start();
   DragMessage("native-drag-started",token,false,null,null,count);
   var effect=DoDragDrop(data,DragDropEffects.Copy);
   cancelled=cancelled||!released;outcome=cancelled?"cancelled":effect==DragDropEffects.Copy?"accepted":"not-accepted";
   if(testing)File.WriteAllText(Path.Combine(profile,"native-file-drag.json"),json.Serialize(new{files=paths,effect=effect.ToString(),released,cancelled,result=outcome}));
  }catch(OperationCanceledException){cancelled=true;}
  catch(Exception e){cancelled=true;failure=e.Message;outcome="error";}
  finally{if(timer!=null){timer.Stop();timer.Dispose();}if(query!=null)QueryContinueDrag-=query;if(changedDrop&&view!=null&&!view.IsDisposed)try{view.AllowExternalDrop=previousDrop;}catch{}fileDragging=false;activeDragToken=null;cancelFileDrag=false;}
  DragMessage("native-drag-finished",token,cancelled,failure,outcome,count);
 }
 async void Initialize(){
  if(initialized)return;initialized=true;
  try{
   // Production has no remote debugging port. The isolated native-window test
   // opts in explicitly and uses its own profile under the temporary test root.
   var options=new CoreWebView2EnvironmentOptions();if(testing&&debugPort>=1024&&debugPort<=65535)options.AdditionalBrowserArguments="--remote-debugging-port="+debugPort+" --remote-debugging-address=127.0.0.1";
   var environment=await CoreWebView2Environment.CreateAsync(null,profile,options);if(terminating||IsDisposed)return;if(view!=null){view.Dispose();Controls.Remove(view);}view=new WebView2{Dock=DockStyle.Fill,DefaultBackgroundColor=BackColor};Controls.Add(view);view.BringToFront();await view.EnsureCoreWebView2Async(environment);if(terminating||IsDisposed)return;
   var core=view.CoreWebView2;var settings=core.Settings;settings.AreDefaultContextMenusEnabled=false;settings.AreDevToolsEnabled=false;settings.AreBrowserAcceleratorKeysEnabled=false;settings.IsStatusBarEnabled=false;settings.IsZoomControlEnabled=false;settings.IsSwipeNavigationEnabled=false;settings.AreHostObjectsAllowed=false;settings.IsWebMessageEnabled=true;settings.IsGeneralAutofillEnabled=false;settings.IsPasswordAutosaveEnabled=false;
   core.Profile.PreferredColorScheme=CoreWebView2PreferredColorScheme.Dark;
   core.NavigationStarting+=(s,e)=>{if(!Own(e.Uri)){e.Cancel=true;if(e.IsUserInitiated)External(e.Uri);}};
   core.NewWindowRequested+=(s,e)=>{e.Handled=true;if(e.IsUserInitiated)External(e.Uri);};
   core.PermissionRequested+=(s,e)=>{e.State=Own(e.Uri)&&e.PermissionKind==CoreWebView2PermissionKind.ClipboardRead?CoreWebView2PermissionState.Allow:CoreWebView2PermissionState.Deny;e.Handled=true;};
   core.WebMessageReceived+=(s,e)=>{if(testing)File.WriteAllText(Path.Combine(profile,"native-message.json"),json.Serialize(new{source=e.Source,trusted=Own(e.Source),message=e.WebMessageAsJson}));if(!Own(e.Source))return;try{var m=json.DeserializeObject(e.WebMessageAsJson) as System.Collections.Generic.Dictionary<string,object>;if(m==null||!m.ContainsKey("type"))return;string kind=Convert.ToString(m["type"]);if(kind=="cancel-file-drag"){if(fileDragging&&m.ContainsKey("token")&&Convert.ToString(m["token"])==activeDragToken)cancelFileDrag=true;}else if(kind=="drag-files"){if(!fileDragging){fileDragging=true;cancelFileDrag=false;activeDragToken=m.ContainsKey("token")?Convert.ToString(m["token"]):"";BeginInvoke(new Action(()=>DragFiles(m)));}else DragMessage("native-drag-finished",m.ContainsKey("token")?Convert.ToString(m["token"]):"",true,"上一项拖拽仍在结束，请稍后重试","error");}else if(kind=="minimize")WindowState=FormWindowState.Minimized;else if(kind=="maximize")WindowState=WindowState==FormWindowState.Maximized?FormWindowState.Normal:FormWindowState.Maximized;else if(kind=="close")Close();}catch(Exception failure){if(testing)File.WriteAllText(Path.Combine(profile,"native-message-error.txt"),failure.ToString());}};
   core.DownloadStarting+=(s,e)=>{
    string uri=e.DownloadOperation.Uri;if(!Own(uri)&&!(uri.StartsWith("blob:")&&Own(uri.Substring(5)))){e.Cancel=true;return;}
    string suggested=Path.GetFileName(e.ResultFilePath);if(String.IsNullOrEmpty(suggested))suggested="AssetNest.eaglepack";
    if(testing){Directory.CreateDirectory(Path.Combine(profile,"downloads"));e.ResultFilePath=Path.Combine(profile,"downloads",suggested);e.Handled=true;return;}
    string ext=Path.GetExtension(suggested).ToLowerInvariant(),filter=ext==".zip"?"ZIP 压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*":ext==".json"?"JSON 报告 (*.json)|*.json|所有文件 (*.*)|*.*":"Eagle 素材包 (*.eaglepack)|*.eaglepack|所有文件 (*.*)|*.*";
    e.Handled=true;var deferral=e.GetDeferral();BeginInvoke(new Action(()=>{try{using(var dialog=new SaveFileDialog{Title="保存文件",FileName=suggested,Filter=filter,OverwritePrompt=true}){if(dialog.ShowDialog(this)==DialogResult.OK)e.ResultFilePath=dialog.FileName;else e.Cancel=true;}}catch{e.Cancel=true;}finally{deferral.Complete();}}));
   };
   core.ProcessFailed+=(s,e)=>{if(e.ProcessFailedKind==CoreWebView2ProcessFailedKind.BrowserProcessExited||e.ProcessFailedKind==CoreWebView2ProcessFailedKind.RenderProcessExited){status.Text="界面进程已退出。素材保存在原位置，请关闭窗口后从托盘重新打开。";view.Dispose();Controls.Remove(view);view=null;initialized=false;status.BringToFront();}};
   await core.AddScriptToExecuteOnDocumentCreatedAsync("if(location.origin==="+json.Serialize(home)+"){Object.defineProperty(window,'assetnestDesktop',{value:Object.freeze({host:'webview2',version:'0.13.0',fileDrag:true})});}");
   core.NavigationCompleted+=(s,e)=>{if(e.IsSuccess)status.Visible=false;else{status.Text="界面加载失败，请关闭窗口后从托盘重新打开。";status.Visible=true;status.BringToFront();initialized=false;}};
   core.Navigate(home);
   if(testing)File.WriteAllText(Path.Combine(profile,"native-host.json"),json.Serialize(new{host="webview2",runtime=environment.BrowserVersionString,defaultContextMenus=settings.AreDefaultContextMenusEnabled,devTools=settings.AreDevToolsEnabled,browserAccelerators=settings.AreBrowserAcceleratorKeysEnabled,statusBar=settings.IsStatusBarEnabled,handle=Handle.ToInt64(),processId=Process.GetCurrentProcess().Id,title=Text}));
  }catch(Exception e){if(terminating||IsDisposed)return;if(view!=null){view.Dispose();Controls.Remove(view);view=null;}initialized=false;status.Visible=true;status.Text="客户端界面启动失败："+e.Message+"\n请确认 Microsoft Edge WebView2 Runtime 已安装。";status.BringToFront();try{File.WriteAllText(Path.Combine(Path.GetDirectoryName(stateFile),"native-window-error.log"),e.ToString());}catch{}}
 }
 public void Present(){if(IsDisposed)return;Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;ShowWindow(Handle,WindowState==FormWindowState.Maximized?3:5);Activate();BringToFront();ApplyTheme();ProbeState();if(!initialized)Initialize();}
 public void Shutdown(){terminating=true;SaveState();if(view!=null){view.Dispose();view=null;}Close();Dispose();}
}
