# 认证、请求流程与凭据处理

以下描述对应此仓库的实际实现。它是单机服务的共享连接密钥机制，没有用户注册、密码登录、OAuth、JWT、Cookie 会话或按用户划分的权限系统。

## 组件

| 组件 | 代码 | 职责 |
| --- | --- | --- |
| HTTP 服务 | server.mjs | 生成并校验密钥，校验 Host、Origin 和目标素材库，提供 API、静态页面和媒体 |
| 本机前端 | public/app.js 的 init、api、post | 从 bootstrap 取得密钥，在内存持有，向 API 添加请求头 |
| 自动配对 | extension/auto-connect.js 的 localServer、pair | 只连接回环 HTTP 地址，通过临时本机页面读取 bootstrap 并保存配置 |
| 扩展采集工作进程 | extension/capture-worker.js 的 config、api | 读取扩展本地配置，发送认证请求，401 时最多自动重新配对一次 |
| 手动配置 | extension/options.js、options.html | 编辑服务地址与密钥；密钥输入框使用 password 类型 |
| 临时操作令牌 | transfers.mjs、trash.mjs | 将导入确认、导出下载、回收站确认绑定到暂存操作 |

## 启动与前端请求

1. server.mjs 确定初始 ASSETNEST_DATA（默认 data/），在该目录创建 connection-key。内容为 crypto.randomBytes(32) 的十六进制字符串，即 256 位随机数、64 个字符；已有文件则读取复用。
2. 服务只监听 127.0.0.1，默认端口 41600。Host 必须为该端口的 127.0.0.1 或 localhost。
3. 前端 init() 请求 GET /api/bootstrap，得到 key、libraryId 等本机配置。该路由在通用密钥检查之前处理，仅拒绝非本机 Origin 与 Sec-Fetch-Site: cross-site；没有 Origin 的本机请求也可以访问。
4. 前端 api() 将 X-Assetnest-Key 和 X-Assetnest-Library 加入请求。服务直接比较密钥字符串，错误返回 401；不匹配的目标库返回 409。libraryId 是目标一致性标识，不是密码。
5. Origin 存在时，普通 API 只允许本机页面或 chrome-extension:// 来源。部分维护、桌面和删除确认接口进一步拒绝扩展来源。

## 扩展自动连接

1. localServer() 拒绝非 http 协议、非 localhost/127.0.0.1 主机以及 URL 用户名、密码、额外路径、查询串和片段。
2. pair() 先请求公开的 /api/health，检查服务名称、素材库和位置设置。
3. 创建后台临时标签页 /?assetnest-pair=1，在其顶层框架执行同源 fetch('/api/bootstrap')，使用 credentials: omit 和 cache: no-store。
4. 检查返回的密钥格式、libraryId 和端口后，将 server、key、autoConnect、autoConnectedAt、connectedLibrary 写入 chrome.storage.local，最后关闭临时页。连接密钥不放入 URL。
5. capture-worker.js 从扩展本地存储读取密钥，通过 X-Assetnest-Key 发送给配置的本机服务。允许自动连接时，401 会触发一次重新配对和重试。

服务允许 chrome-extension:// 来源的 CORS 请求，并允许必要请求头；没有绑定某个扩展 ID。连接密钥代表对本机 API 的广泛访问权，部分接口附加的来源限制也不是用户角色系统。

## 密钥生命周期与边界

- connection-key 以明文文件保存；扩展 chrome.storage.local 也不做应用层加密。前端只在内存持有，但设置界面可以展示和复制密钥。
- 密钥属于本次服务启动的数据目录，之后切换活动素材库不会重新生成；服务代码中的 KEY 为启动时常量。
- 没有自动过期、定时轮换、哈希存储或常量时间比较。需要轮换时，停止服务，移走初始数据目录中的 connection-key，重启以生成新密钥，并让扩展重新配对。不要提交旧文件。
- HTTP 是回环本机传输，没有 TLS。能够读取本机文件、扩展存储或访问本机 bootstrap 的进程处于信任边界内。
- /api/health 无需密钥。/media/ 的 GET/HEAD 在通用 /api/ 检查之外，不要求连接密钥；如提供素材库头会检查一致性。静态资源同样不要求密钥。因此此机制不保护素材免受同一台电脑上的其他进程访问。
- bootstrap 没有服务端 Cache-Control: no-store；扩展配对请求显式禁用缓存，主前端请求使用 fetch 默认缓存行为。
- 不应通过公网监听、反向代理或端口映射将此服务当作多用户服务部署。现有设计依赖本机隔离。

## 其他令牌

| 标识 | 产生与保存 | 有效期和检查 |
| --- | --- | --- |
| 导入预检 token | transfers.mjs，随机 UUID，内存 Map | 5 分钟；确认导入仍需要 API 密钥和目标库检查 |
| 导出下载 token | transfers.mjs，24 随机字节转 hex，内存任务 | 任务结束后 10 分钟；/download/<token> 校验完成任务和有效期，加来源检查，不再要求 API 密钥；按 bearer 链接保护 |
| 回收站确认 token | trash.mjs，随机 UUID，内存 Map | 5 分钟；重新计算内容指纹，拒绝变化；确认后移除；API 还要求密钥并拒绝扩展来源 |
| idempotencyKey | 扩展队列任务与条目序号，服务数据库回执 | 防止重试重复入库，不是认证凭据，不授予权限 |

## 第三方网站登录态

扩展 capture-worker.js 的 imageData() 和 page-tools.js 的 readImageInPage() 使用 credentials: include 请求目标图片，浏览器按自身 Cookie、跨站及权限策略决定是否携带登录态。代码没有读取 Cookie API 或将网站密码作为配置保存。原页面读取只返回图片字节。Node 服务 download() 不使用浏览器 Cookie，并拒绝含用户名或密码的图片 URL。

素材元数据会记录来源 URL、名称与注释；URL 可能本身包含网站签名参数，素材库、备份和导出包应视为用户数据，不应作为源码附件公开。

## 现有验证

auto-connect.test.mjs 验证连接地址边界和离线/错误服务处理；test.mjs、stage2.test.mjs、preview-tasks.test.mjs、trash.test.mjs 等覆盖 API 密钥、来源、目标库与操作确认的相关行为。运行 npm test 查看全部结果。这些测试不代表完整的安全审计。
