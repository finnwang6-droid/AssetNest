using System;
using System.Windows.Forms;
using System.Web.Script.Serialization;
class FolderPicker {
 [STAThread] static void Main(string[] args) {
  Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  Application.EnableVisualStyles();
  using(var form=new Form()) using(var picker=new FolderBrowserDialog()) {
   form.TopMost=true;form.ShowInTaskbar=false;form.Opacity=0;form.Show();
   picker.Description="选择素材库文件夹（可新建文件夹）";picker.ShowNewFolderButton=true;
   if(args.Length>0&&System.IO.Directory.Exists(args[0]))picker.SelectedPath=args[0];
   bool ok=picker.ShowDialog(form)==DialogResult.OK;
   Console.WriteLine(new JavaScriptSerializer().Serialize(new {cancelled=!ok,directory=ok?picker.SelectedPath:null}));
  }
 }
}
