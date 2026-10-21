# LiteCode

Windows 11 x64 本地代码编辑器初始版本，使用 Tauri 2、React 19 / React Compiler、Monaco classic、Zustand、Base UI 和 Tailwind CSS。文件树使用固定版本 `@pierre/trees@1.0.0-beta.6`，界面为英文 Dark Modern。

**当前是可运行的初始实现，尚未完成 DEVELOPMENT_PLAN.md 的全部验收。** 已实现的能力、实测证据与剩余工作分别见 [验收矩阵](docs/verification/MATRIX.md)、[已知限制](docs/verification/LIMITATIONS.md)。尤其不能将现有截图视为已通过固定版本 VS Code 的 UI 对比。

后续任务安排见 [首版剩余任务清单](REMAINING_TASKS.md)，包含优先级、前置依赖、代码入口和验收条件。

## 运行与构建

需要 Windows x64、Node.js 24、Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2。

```powershell
npm ci
npm run build:tools
npm run tauri dev
```

仅运行前端用 `npm run dev`；浏览器模式不会伪造本地文件或工具服务。

`npm ci` / `npm install` 及 Vite 启动时会自动运行 `tools/patch-trees-scroll.mjs`，为固定版本的文件树补上可滚动的底部留白；开发服务的依赖缓存按补丁内容区分，防止旧组件缓存覆盖补丁。升级 `@pierre/trees` 时需复核该兼容补丁。

```powershell
npm run tauri build
node tools/package-portable.mjs
```

发行构建自动生成 HTML/CSS/JSON 服务包，再编译前端与 Rust，输出 NSIS 安装包。便携打包脚本将 exe、工具资源和独立 `data` 目录装入 ZIP，并生成 SHA-256 manifest，输出到 `artifacts/`。同一构建的 ZIP 已存在时脚本会停止，避免覆盖。

应用图标源文件为 `public/litecode.svg`，标题栏与浏览器标签共用该圆角双蓝色图标。桌面打包使用 `src-tauri/icons/` 下的 PNG、ICO 和 ICNS 文件。更新图标后，运行 `npm run tauri -- icon public/litecode.svg --output .verification/icons`，将生成目录顶层的同名图标文件复制到 `src-tauri/icons/`，再重新构建桌面应用。

## 文件、搜索与编辑

- Markdown（`.md` / `.markdown`）默认文本编辑，可在面包屑右侧切换 `Text Editor` / `Markdown Preview`。预览支持常用 Markdown、表格和任务列表，展示当前未保存内容；可通过现有分栏功能一侧编辑、一侧实时预览。切换保留编辑位置和撤销历史，各分组独立保存视图与预览滚动位置，并随会话恢复。
- Markdown 支持文内标题锚点、本地图片与文件链接，以及 HTTP/HTTPS 图片；本地路径相对文档目录解析并沿用窗口的文件访问授权，未保存文档的相对资源需要先保存才能解析。网页和邮件链接通过系统默认程序打开；原始 HTML 不参与渲染，不支持 Mermaid、数学公式、代码语法着色或滚动同步。
- 支持 JPG/JPE/JPEG、PNG、BMP、GIF、ICO、WebP、AVIF、SVG 图片预览，默认适应窗口；点击放大、Ctrl+点击缩小、Ctrl+滚轮连续缩放，聚焦预览后可用 `+` / `-` / `0` 放大、缩小、恢复原始尺寸。底部显示缩放、原始宽高和文件大小，点击缩放可选择比例或 `Whole Image`。
- SVG 默认图片预览，可在面包屑右侧切换 `Image Preview` / `Text Editor`；预览使用当前未保存的源码，切换保留撤销历史，各分组可独立选择视图。媒体标签、视图和缩放随会话恢复。
- 支持 MP4/WebM 视频和 MP3/WAV/OGG/OGA 音频的原生播放控件，播放能力取决于 Windows WebView2 的编解码器。媒体通过按窗口授权的本地协议加载，音视频支持 Range 请求及进度拖动；其他二进制文件或不支持的文本编码在编辑区域展示提示。

- 未打开文件夹且没有文件标签时，编辑区显示初始页，提供新建文件、打开文件、打开文件夹及最近文件夹入口；关闭全部单文件标签后会返回初始页。
- `Ctrl+P` 打开文件；支持路径、`:行:列`，以及 `>` 命令、`@` 当前文档符号、`#` 工作区符号、`%` Quick Search、`?` 帮助。
- 文件树默认单击预览并保留树中焦点，双击或按 `Enter` 固定文件并聚焦编辑器。兼容 VS Code 的 `workbench.list.openMode`：`singleClick`（默认）或 `doubleClick`（单击仅选中）；可在用户设置或 `.litecode/settings.json` 中修改，保存后即时生效。
- 打开或切换文件时，编辑器标签按最小滚动距离进入可视区域；重复打开当前文件也会定位标签。后台打开不强制滚动，手动滚动后不会因普通编辑更新被拉回。标签背景、文字及悬停颜色按提供的 VS Code 截图对齐；横向滚动条覆盖显示在标签底部，不占用布局高度，支持滚轮、滑块拖动及轨道点击。
- 侧边栏和编辑器使用 Allotment 调整大小；View 菜单、标签右键菜单和编辑器组工具栏支持上下左右嵌套分屏。连续同向分屏按 VS Code 的默认策略分配尺寸，手动调整后仅平分目标区域；双击分隔线平衡相邻区域，聚焦分隔线后可用方向键调整。`Ctrl+\` 和“在侧边打开”遵循 `workbench.editor.openSideBySideDirection`（`right` 或 `down`，默认 `right`）。布局比例、活动组、最近使用顺序及侧边栏显隐随会话恢复。
- 鼠标悬停在文件树的文件或文件夹、编辑器标签、面包屑项目上时，显示对应的完整路径；面包屑的文件夹项目显示该级目录的完整路径。
- 文件修改、增删和手动刷新保留现有目录的展开状态及文件树滚动位置；切换编辑器标签或执行文件树定位仍会展开目标文件的父目录。展开状态不跨应用重启保存。
- `Ctrl+Shift+P` 打开命令面板。`Ctrl+K Ctrl+O` 打开目录，命令面板提供新窗口入口；每个窗口最多一个根目录。
- `Ctrl+F / Ctrl+H` 是 Monaco 查找与替换；`Ctrl+Shift+F` 打开 Search View；`F4 / Shift+F4` 跳转工作区结果。
- 搜索由打包的 PCRE2 ripgrep 执行，叠加未保存和 Untitled 缓冲区；有请求取消、结果上限、Channel 消费确认和版本校验。
- 关闭文件的跨文件替换写入磁盘日志；打开文件进入 Monaco 编辑栈。命令 `Undo Workspace Replacement` / `Redo Workspace Replacement` 控制关联操作。
- `Ctrl+\\` 分栏；同一文档共享模型，各视图保留光标和滚动。保存检查磁盘哈希，冲突提供 Compare / Overwrite / Reload。
- 退出会先写恢复数据；进程异常终止后的恢复取决于最近一次完成的备份，编辑备份有约 400 ms 延迟。

## 设置与语言工具

`.gitignore` 和 `.env`（包含 `.env.*`）支持语法高亮：忽略规则中的注释、否定标记和通配符，以及环境变量的键名、字符串、注释和变量引用使用不同颜色。也可通过状态栏语言模式手动选择 Git Ignore 或 Dotenv。

命令面板的 `Preferences: Open User Settings (JSON)` 和 `Preferences: Open Keyboard Shortcuts (JSON)` 打开配置文件。工作区覆盖文件是 `.litecode/settings.json`。`Preferences: Review VS Code Settings Import` 读取 `.vscode/settings.json`，生成支持项与忽略项报告，不改写原文件。

设置文件和快捷键文件使用 JSONC：扩展名仍为 `.json`，支持 `//`、`/* ... */` 注释和末尾逗号。打开用户设置命令会补全全部设置的默认值，并为每项添加中文说明及默认值注释；已有值、自写注释和未知字段保留，补全内容可撤销，保存后写入文件。默认值、用户设置、工作区设置按顺序覆盖；删除配置项后恢复下层设置或默认值。语言服务提供设置说明悬停、补全和校验，JSONC 格式化会保留注释。普通 JSON 文件仍进行严格校验。

HTML/CSS/JSON 的 Microsoft 语言服务随应用提供，需要 Node。JS/TS 内置 `typescript-language-server` 6.0.2 和 TypeScript 6.0.3，使用系统 Node.js（22.22.2 或更高版本），不随安装包携带 Node.js；已有 Node.js 时打开文件即可启动语言服务，无需执行工具安装命令。兼容服务器优先使用项目 TypeScript，无项目版本时使用内置 TypeScript。项目使用 TypeScript 7 之前的版本时使用兼容 LSP；其他项目在有原生服务器时优先使用原生服务。Rust 使用项目工具链的 rust-analyzer / rustfmt。

源代码开发和发行构建都会运行 `build:tools` 准备内置语言服务。系统 Node.js 无法从 PATH 找到时，可设置 `litecode.nodePath` 指向 `node.exe`，然后执行 `Language: Restart Language Services`。已有配置路径和用户安装的服务器优先于内置服务器。

需要额外的原生服务和格式化工具时，可按 `Ctrl+Shift+P` 执行 `Language Tools: Install JavaScript/TypeScript Tools`。该可选命令会下载校验并安装 Node.js 和语言工具，成功后自动重新连接已打开文件的语言服务；不会安装或修改项目依赖。命令 `Language Tools: Install Verified Node.js Runtime` 可单独安装 Node.js，成功后同样自动重新连接；安装失败保留已有工具。本环境的应用内下载成功路径尚未验证。

常用配置：

```json
{
  "editor.fontSize": 14,
  "editor.lineHeight": 24,
  "editor.tabSize": 4,
  "editor.formatOnSave": false,
  "files.autoSave": "off",
  "litecode.nodePath": "C:\\Program Files\\nodejs\\node.exe",
  "typescript.native.serverPath": "C:\\tools\\tsgo.exe",
  "rust-analyzer.server.path": "C:\\Users\\you\\.cargo\\bin\\rust-analyzer.exe"
}
```

未配置工具时会明确报错；不会自动安装项目依赖。`Language: Show Service Status` 提供实际运行状态与服务能力。

`editor.lineHeight` 设置编辑器行高，默认 `20`；`0` 表示根据字号自动计算，大于 `0` 且小于 `8` 表示字号倍数（例如 `1.5`），`8` 到 `150` 表示像素。在用户设置或 `.litecode/settings.json` 中修改并保存后即时生效。

## 数据与验证

exe 旁已有 `data/` 时使用便携模式，否则使用 Tauri 的应用数据目录 `com.tingyuan.litecode`。目录包含设置、会话、未保存内容、替换日志和按需工具。备份和设置使用原子写入；文件删除使用回收站。

```powershell
npm run lint
npm test
npm run test:languages
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

JavaScript / TypeScript 使用 Oxlint 检查前端和测试，启用默认插件及 React 的 correctness 规则；暂不启用 React Compiler 的 `immutability`、`preserve-manual-memoization`、`refs`、`set-state-in-effect` 规则。任何警告或错误都会使检查失败。配置见 `.oxlintrc.json`，扫描遵循 `.gitignore`，并排除 `.agents/` 技能资源、`tools/` 工具脚本及 `src-tauri/tools/` 生成的语言服务包。可执行 `npm run lint:fix` 应用安全的自动修复；类型检查仍由 `npm run build` 中的 TypeScript 完成。

真实桌面端测试需要 `tauri-driver` 和匹配 WebView2 版本的 EdgeDriver；先启动 `tauri-driver --port 4446 --native-driver <msedgedriver.exe 路径>`，然后执行 `npm run test:e2e`，或 `node tools/verify-desktop.mjs --release` 验证发行 exe。脚本创建隔离 fixture、便携数据目录并模拟崩溃，不使用个人工作区文件。

标签栏浏览器回归：先启动 `npm run dev`，再执行 `node tools/verify-editor-tabs.mjs`（需要已安装的 Microsoft Edge）。脚本仅模拟 IPC 数据，使用真实文件树、标签栏和 Monaco，覆盖标签定位、文件树焦点、手动滚动、后台打开、预览、分栏、会话恢复与配色；截图保存至 `.verification/editor-tabs/`。

分屏布局浏览器回归：启动 `npm run dev` 后执行 `node tools/verify-layout.mjs`（需要 Microsoft Edge），覆盖四向嵌套、尺寸分配、拖动及键盘调整、相邻区域平衡、共享未保存内容、预览状态和会话恢复；截图保存至 `.verification/layout/`。

文件树与编辑器双向联动回归：启动 `npm run dev` 后执行 `node tools/verify-explorer-sync.mjs`（需要 Microsoft Edge）。切换活动编辑器会展开父目录、选中文件并尽量滚动到视野中部，同时保留编辑器焦点；直接操作文件树时保持条目位置稳定。脚本覆盖居中定位、鼠标/键盘切换、分组、导航、侧栏恢复、Windows 路径和异步树数据更新；截图保存至 `.verification/explorer-sync/`。

媒体预览桌面回归：完成 `cargo build --manifest-path src-tauri/Cargo.toml` 并启动 `npm run dev` 后，执行 `node tools/verify-media.mjs`。脚本在隔离的便携式 Tauri/WebView2 实例中使用真实 IPC 和媒体协议，覆盖图片解码、缩放与滚动恢复、SVG 未保存预览与分屏、会话恢复、二进制提示、音视频播放和文件外部变化；截图及报告保存至 `.verification/media-*/`。也可用 `--app <exe路径>` 指定待测程序。

Windows 文件树支持粘贴资源管理器复制的文件、文件夹和多选项目：选中文件夹后按 `Ctrl+V` 或右键选择 Paste，复制前会列出项目及目标目录并要求确认。选中文件时使用其父目录，工作区标题或空白区域使用根目录；重名项目按 `name copy.ext`、`name copy 2.ext` 递增，来源保持不变。目录联接、符号链接和虚拟附件不支持。应用内复制/剪切仍可使用，系统剪贴板变化后旧记录失效。

真实粘贴回归：执行 `cargo build --manifest-path src-tauri/Cargo.toml` 并启动 `npm run dev` 后，运行 `node tools/verify-explorer-paste.mjs`。脚本使用隔离便携实例、真实 Windows 文件剪贴板和 WebView2，覆盖确认/取消、递归复制、重名、根目录目标、重命名输入框、应用内复制/剪切和过期请求；退出时恢复原剪贴板，截图及结果保存在 `.verification/explorer-paste-*/`。

Trees 官方 skill 已通过 `npx skills add pierrecomputer/pierre --skill trees` 安装到 `.agents/skills/trees`，集成使用官方 React、prepared input、主题和交互 API。依赖锁定在 npm / Cargo lockfile；第三方许可在 [docs/licenses](docs/licenses/)，发行资源带有完整 notices。重新生成清单用 `node tools/notices.mjs`。
