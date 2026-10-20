# 开发与构建

## 服务与测试

安装 Node.js 24+，在仓库根目录运行 npm install、npm start。测试运行 npm test。pnpm-lock.yaml 保留原项目依赖版本，使用 pnpm 也可以安装。

public/vendor/ 中携带 PDF.js 预览所需模块、CMaps、字体与 WASM 文件及其原始许可证。更新时从对应 pdfjs-dist 版本复制并保留所有许可证。

## Windows 原生桌面

需要 Windows x64、.NET Framework C# 编译器和 WebView2 Runtime。

1. 将官方 Node.js 24.19.0 win-x64/node.exe 下载至 runtime/node.exe；tools/build-desktop.mjs 会用仓库内 SHASUMS256.txt 验证其 SHA-256。
2. 运行 powershell -ExecutionPolicy Bypass -File tools/fetch-webview2-sdk.ps1，获取并校验固定版本 WebView2 SDK。
3. 运行 node tools/build-icon.mjs（如需重建图标），然后 node tools/build-desktop.mjs。
4. 生成的安装包位于 releases/，此目录不提交 Git。

源码启动的服务可独立使用，不需要执行桌面构建。源码内没有附带预编译桌面组件、第三方 SDK 二进制或 Node.exe。
