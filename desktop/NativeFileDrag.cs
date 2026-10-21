using System;
using System.IO;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Windows.Forms;

static class NativeFileDrag {
 public static string[] ValidateFiles(object[] values){
  if(values==null||values.Length==0||values.Length>500)throw new Exception("请选择 1 至 500 个原文件");
  var paths=new List<string>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  for(int n=0;n<values.Length;n++){
   string file=values[n] as string;string item="第 "+(n+1)+" 项素材";
   if(String.IsNullOrEmpty(file)||!Path.IsPathRooted(file))throw new Exception(item+"的文件路径无效");
   // Keep standard shell paths compatible with receivers using MAX_PATH.
   if(file.Length>=260)throw new Exception(item+"的原文件路径过长，请先导出到较短目录，再拖给目标软件");
   try{if(!String.Equals(Path.GetFullPath(file),file,StringComparison.OrdinalIgnoreCase))throw new Exception(item+"的文件路径无效");}
   catch(PathTooLongException){throw new Exception(item+"的原文件路径过长，请先导出到较短目录");}
   if(!File.Exists(file))throw new Exception(item+"的原文件已丢失或无法访问，请先在资源管理器中检查");
   if(seen.Add(file))paths.Add(file);
  }
  return paths.ToArray();
 }
 public static DataObject CreateData(string[] paths){
  var data=new DataObject();var files=new StringCollection();files.AddRange(paths);data.SetFileDropList(files);
  data.SetData("Preferred DropEffect",new MemoryStream(new byte[]{1,0,0,0}));return data;
 }
}
