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

## macOS 桌面版

在 Apple 芯片 Mac 上使用 Node.js 24+，执行 `npm ci`、`npm run build:mac`。
构建输出为 `releases/AssetNest-0.14.5-mac-arm64.dmg` 和 ZIP，包含独立 Node.js 运行时与服务依赖，无需用户安装 Node.js。依赖按构建机架构安装；Intel 构建需要在 Intel 环境重新安装依赖并构建。

开发启动：`npx electron .`（Node.js 默认路径 `/usr/local/bin/node`，可用 `ASSETNEST_NODE` 覆盖）。默认素材数据与日志位于 `~/Library/Application Support/AssetNest/library`，首次启动自动创建默认素材库，可在应用中更换位置。关闭窗口后服务继续运行，使用 Dock 或 `⌘⌥Space` 再次显示，`⌘Q` 完全退出。

Mac 版支持 Finder 定位、默认应用打开、系统文件夹选择、文件导入导出及浏览器采集。素材拖到其他应用的系统级原件拖放暂未实现；可使用导出或 Finder 定位。安装包尚未使用 Apple Developer ID 签名或公证，适用于本地测试。

测试可用 `TMPDIR=/private/tmp npm test`，避免 macOS `/var` 到 `/private/var` 的系统别名触发测试夹具的目录链接保护。Mac 启动冒烟检查：设置 `ASSETNEST_MAC_SMOKE=1` 和独立的 `ASSETNEST_DATA` 后启动应用；该目录会生成 `mac-smoke.json` 和截图，检查后应用自行退出。

Mac 扩展通过带连接密钥的 `POST /api/desktop/show` 请求桌面父进程前置窗口（Node IPC）；不向网页暴露 IPC 或文件操作。成功采集通知打开桌面，重复选择和失败重试仍使用扩展任务界面。新建素材库使用 `POST /api/libraries/create`，接收父目录与库名，自动创建子目录并切换；拒绝同名已有目录。

## Windows 同步修复

Windows 源码共用新的“选择保存位置 → 输入名称 → 创建并切换”界面。例如选择 `D:\`、名称“日常”，会创建 `D:\日常.library`，不要求 D 盘为空，不覆盖已有同名文件夹。Windows 首次启动也会自动建立默认素材库。

浏览器扩展 0.6.3 的采集成功通知使用认证的 `/api/desktop/show`。Windows 服务调用安装目录的 `AssetNest.exe /show /port=41600`，仅向已有桌面实例的命名事件发送唤起信号；该参数不会另启服务或打开浏览器。更新客户端与插件后再重新加载插件并刷新网页。

在 Windows x64 安装 Node.js 24+ x64 后，双击 `build-windows.cmd`。脚本安装服务依赖、运行测试、下载并校验固定版本的 Node.js 与 WebView2 SDK，再构建 EXE 与插件包，输出到 `releases/`。需要系统已有 .NET Framework C# 编译器；桌面运行仍需 WebView2 Runtime。Mac 上的跨平台测试不等于 Windows 原生编译与窗口行为验证。
