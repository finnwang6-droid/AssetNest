# 第三方组件

AssetNest 原创代码和自绘 SVG 使用 MIT；第三方内容不因仓库根 LICENSE 而重新许可。

- PDF.js / pdfjs-dist：public/vendor/pdf.mjs、pdf.worker.mjs 与 pdfjs/，保留 public/vendor/PDFJS-LICENSE.txt 及子目录的 LICENSE* 文件。字体、CMaps 和编解码器以各自随附声明为准。
- Node.js：源码仓库不附带可执行文件；runtime/NODE-LICENSE.txt 保留用于桌面分发的运行时及内含依赖声明。
- npm 依赖 fflate、sharp、ag-psd 等：安装后保留对应包内许可证；依赖版本见 package.json 和 pnpm-lock.yaml。
- WebView2：由 tools/fetch-webview2-sdk.ps1 从官方 NuGet 源获取；分发桌面程序时保留 SDK 的 LICENSE.txt 和 NOTICE.txt，构建脚本负责打包。

未包含从 Eagle 提取的商业图标、应用程序或用户素材。public/vendor/folder-icons/ 为原创 SVG 图形，按 MIT 发布。
