# 架构

## 运行边界

Service Worker 接收来自扩展页面的受控消息，检查来源和网站权限，按需创建一个 Offscreen Document。Offscreen 使用 DOMParser、Fetch 和 IndexedDB，负责目录、预览和下载；正文不经过网站脚本。

长任务保存在 Offscreen，避免将下载循环绑在弹窗、来源标签页或 Service Worker 的内存生命周期。浏览器或 Offscreen 被回收时，已提交正文保留；重新启动时任务变为暂停。恢复警报只检查状态，不靠伪造事件保活，也不自动续抓。

管理页和网页悬浮阅读 iframe 与扩展同源，可以共享 IndexedDB；网页内容脚本仅管理浮层位置与显示，通过运行时注入，不默认扫描所有网页。第三方页面的 postMessage 不提供文件、网络或书库操作接口。

## 消息与任务

`Operation` 联合类型定义 scan、preview、start、pause、resume、cancel、status、export、read-job、health 、open-online、online-chapter 与 reader-toggle。响应为 `{ok:true,data}` 或 `{ok:false,error}`。UI 不接触内部授权、下载 Blob 与后台事件接口。

下载任务保留完整目录和选定的零基索引 start/end；仅选定范围计入完成率和导出。不同章节并发，同章分页串行。正文标题、分页序号、总页数、下一章位置与 URL 均被校验。

调度器控制每次请求的启动时间与活动连接数。重试重新进入队列；429 等待时间施加到整条队列，并将并发减半，连续成功 20 次恢复一个并发。HTTP 403、验证提示和解析异常停止任务。

## 数据与阅读

数据库版本 1 包含 jobs、records、books、chunks、positions。章节正文和任务计数在同一事务提交，并发提交串行化以避免丢失计数。旧任务继续保留在本机，不上传。

TXT 规范化后按内容摘要去重；每个章节按 10000 字符拆块。阅读器最多挂载三个正文块，滚动替换时使用文字偏移恢复锚点；进度独立保存为章节索引和字符偏移。首次导入需要读取完整文件，因此设定 32 MiB 文件上限。

## 构建

WXT 生成 Manifest V3。构建钩子去除运行时内容脚本引入的隐式全站 host_permissions，保留 optional_host_permissions；授权通过浏览器标准确认流程完成。所有 JS / CSS 随包构建，不加载 CDN 脚本。

## 网页悬浮入口

阅读默认注入已有普通网页。浮层内完成书架选择和 TXT 导入，不调用 tabs.create 打开阅读页面；内部页或权限不足时显示切换普通网页的提示。storage.session 只记录上次浮层的 tabId，以便从工作台回到该网页，不保存浏览记录。reader.html 是 iframe 的隔离渲染入口，不是默认新标签页入口。

## 同窗下载与在线阅读（0.1.1）

Popup 的下载、阅读、书架、在线导入入口全部走 reader-toggle(view)，向当前普通网页注入同一个 iframe。Reader 内保持下载表单挂载，用隐藏面板切换保留目录和范围；Manager 的完整页面仅保留兼容入口，默认不创建标签页。正文、下载表单和网站 CSS 均由 iframe 隔离。

scanCatalog 复用目录分页和排序；open-online 识别完整目录或正文中的实际目录链接，按目录网址摘要去重。Book.online 保存完整目录，chunks=0 表示尚未缓存的章节。online-chapter 对单章逐页进行既有连续性校验，完整后在 books/chunks 同一事务提交；半章失败不会被当作完整缓存。相同章节的并行请求共享 Promise，不同章节提交从事务内读取最新元数据，防止字符统计丢失。

相同来源和相同设置共享 Scheduler，目录、预览、正文、分页、在线阅读和重试统一错开请求。在线阅读可以与后台下载并存；其缓存独立于任务检查点。阅读位置沿用章节索引和文字偏移，刷新后恢复，已经缓存的章节无需联网。
