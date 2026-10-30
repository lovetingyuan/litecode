# 启动耗时诊断（2026-10-30）

已增加前后端分段日志，并用真实 Tauri / WebView2 实例加载正式构建资源进行测量。

## 为什么原来的 loading 不能马上出现

`index.html` 已经包含内联样式和 spinner，但 `main.tsx` 静态导入了整个 App。
这条依赖链包含 Monaco、VS Code 服务、语言客户端以及工作台 CSS。Vite 原先将这些
CSS 作为 HTML 中的 stylesheet 加载；这些样式和 JS 的执行都会影响首次绘制。
React 中的 “Starting editor services…” 更晚，必须等整个模块图执行、React 挂载后才能显示。

另有一段时间发生在 HTML 加载之前：Tauri 创建窗口和 WebView2 环境。网页中的 loading
无法覆盖这一阶段。这里如果仍需立即显示反馈，需要单独的原生启动提示。

## 改动

- 启动入口只加载无依赖的计时工具，等待浏览器实际报告首次绘制后，再动态导入工作台。
- React、Monaco 和工作台 CSS 进入异步模块，移出 HTML 的首屏阻塞依赖。
- 后端会话读取与编辑器服务初始化并行；恢复文档仍等待两者完成。
- 工作台模块下载失败时保留错误提示和 Reload 按钮。
- 保留结构化分段日志，不记录文件正文或用户路径。

## 实测与限制

固定同一个 WebView2 进程，关闭 HTTP 缓存，交替加载基线和优化后的正式资源，各测三次。
空会话的结果如下，时间均相对于页面导航开始：

| 项目               | 基线               | 优化后          |
| ------------------ | ------------------ | --------------- |
| 首次绘制，三次     | 376 / 380 / 476 ms | 64 / 72 / 80 ms |
| 首次绘制，中位数   | 380 ms             | 72 ms           |
| 工作台就绪，中位数 | 673 ms             | 835 ms          |

loading 明显提前，但这组结果不能宣称总启动耗时缩短。让 loading 先显示会增加一点模块
加载等待；编辑器的大依赖图仍然存在。下一步应重点减少或延后欢迎页不需要的编辑器/语言服务，
而不是继续优化很短的会话 JSON 读取。

另测了每次创建全新 WebView2 数据目录的冷启动。窗口/WebView 初始化前的耗时、资源加载时间
波动很大，不适合据此计算优化百分比。测试使用 debug 原生程序和正式前端资源，并非安装版
release 程序的完整启动基准。初次基线中编辑器服务初始化约 0.4–0.8 秒；后端恢复和配置读取
实际工作通常在毫秒级。不同阶段和不同计时起点不能混为同一个“启动时间”。

原始结果保存在 `.verification/startup/interleaved.json`；独立冷启动结果保存在该目录的
`baseline-*/results.json` 和 `final-*/results.json` 中。该目录不纳入 Git。

## 日志与复测

前端控制台筛选 `[startup]`，或读取 `performance.getEntriesByType("mark")` 中
`startup:` 开头的条目。日志涵盖入口、loading 绘制、工作台模块、React 挂载、编辑器服务、
语法注册、bootstrap、会话恢复、目录/文档刷新及工作台绘制。

Rust debug 构建向 stderr 输出日志。需要保存安装版日志时，在启动前设置
`LITECODE_STARTUP_LOG` 为可写 JSONL 文件路径。其阶段包含进程入口、setup 和 bootstrap
中的调度、锁等待、恢复、watcher、配置读取。文件写入本身也有开销，测量时保持前后配置一致。

启动开发应用后可运行：

```powershell
node tools/verify-startup.mjs --expect-early-loading
node tools/verify-startup-loading.mjs
```

前一个脚本复制 debug 可执行文件到隔离的 portable 数据目录，运行三次并保存时间点和截图。
`--profile=路径` 可复用一个测试 WebView2 目录；默认每次新建。`--exe=路径`、`--url=地址`
可指定测试版本，URL 必须匹配该程序编译时的 devUrl，才能正常调用 Tauri IPC。

后一个脚本用独立 Chrome 测试：阻塞工作台 JS/CSS 时仍能显示 loading、减少动画偏好、
模块下载失败提示以及 Reload 重试。它也可用 `--url=地址` 指向 Vite preview 的正式资源。
`CHROME_PATH` 可指定 Chrome 可执行文件。

## 验证结果

- 正式前端资源构建、Rust debug 构建、TypeScript、lint、Rust 格式检查通过。
- loading 在 JS/CSS 阻塞时独立显示、减少动画偏好、导入失败和重试的浏览器检查通过。
- `vitest run src tools/trees --maxWorkers=2`：42 个文件、705 个测试通过。
- 完整测试运行：713 个通过，发布脚本中的一项 Git 事务测试超过 30 秒超时；未改动该发布逻辑。
