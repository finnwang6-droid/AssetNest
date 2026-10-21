# 开发与构建

## 服务与测试

安装 Node.js 24+，在仓库根目录运行 npm install、npm start。测试运行 npm test。pnpm-lock.yaml 保留原项目依赖版本，使用 pnpm 也可以安装。

public/vendor/ 中携带 PDF.js 预览所需模块、CMaps、字体与 WASM 文件及其原始许可证。更新时从对应 pdfjs-dist 版本复制并保留所有许可证。

Windows 的原生文件数据测试 `native-file-drop.test.mjs` 随主测试运行。构建安装包后，可设置 `PLAYWRIGHT_MODULE` 为 Playwright 模块位置，运行 `node tools/native-drag-browser-check.mjs`，在独立安装和素材库中验证准备、取消与失败恢复；该检查不会向聊天程序拖放或发送文件。

## Windows 原生桌面

需要 Windows x64、.NET Framework C# 编译器和 WebView2 Runtime。

1. 将官方 Node.js 24.19.0 win-x64/node.exe 下载至 runtime/node.exe；tools/build-desktop.mjs 会用仓库内 SHASUMS256.txt 验证其 SHA-256。
2. 运行 powershell -ExecutionPolicy Bypass -File tools/fetch-webview2-sdk.ps1，获取并校验固定版本 WebView2 SDK。
3. 运行 node tools/build-icon.mjs（如需重建图标），然后 node tools/build-desktop.mjs。
4. 生成的安装包位于 releases/，此目录不提交 Git。

运行 node tools/package-release.mjs 生成浏览器扩展 ZIP、软件与扩展完整包和 SHA256SUMS.txt，用于上传 GitHub Releases。打包器沿依赖关系收集已安装的服务端依赖，支持 npm 与 pnpm 布局，并保留各包许可证；PDF.js 使用 public/vendor/ 中的固定资源。

源码启动的服务可独立使用，不需要执行桌面构建。源码内没有附带预编译桌面组件、第三方 SDK 二进制或 Node.exe。
