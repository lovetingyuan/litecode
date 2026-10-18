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

```powershell
npm run tauri build
node tools/package-portable.mjs
```

发行构建自动生成 HTML/CSS/JSON 服务包，再编译前端与 Rust，输出 NSIS 安装包。便携打包脚本将 exe、工具资源和独立 `data` 目录装入 ZIP，并生成 SHA-256 manifest，输出到 `artifacts/`。同一构建的 ZIP 已存在时脚本会停止，避免覆盖。

## 文件、搜索与编辑

- `Ctrl+P` 打开文件；支持路径、`:行:列`，以及 `>` 命令、`@` 当前文档符号、`#` 工作区符号、`%` Quick Search、`?` 帮助。
- `Ctrl+Shift+P` 打开命令面板。`Ctrl+K Ctrl+O` 打开目录，命令面板提供新窗口入口；每个窗口最多一个根目录。
- `Ctrl+F / Ctrl+H` 是 Monaco 查找与替换；`Ctrl+Shift+F` 打开 Search View；`F4 / Shift+F4` 跳转工作区结果。
- 搜索由打包的 PCRE2 ripgrep 执行，叠加未保存和 Untitled 缓冲区；有请求取消、结果上限、Channel 消费确认和版本校验。
- 关闭文件的跨文件替换写入磁盘日志；打开文件进入 Monaco 编辑栈。命令 `Undo Workspace Replacement` / `Redo Workspace Replacement` 控制关联操作。
- `Ctrl+\\` 分栏；同一文档共享模型，各视图保留光标和滚动。保存检查磁盘哈希，冲突提供 Compare / Overwrite / Reload。
- 退出会先写恢复数据；进程异常终止后的恢复取决于最近一次完成的备份，编辑备份有约 400 ms 延迟。

## 设置与语言工具

命令面板的 `Preferences: Open User Settings (JSON)` 和 `Preferences: Open Keyboard Shortcuts (JSON)` 打开配置文件。工作区覆盖文件是 `.litecode/settings.json`。`Preferences: Review VS Code Settings Import` 读取 `.vscode/settings.json`，生成支持项与忽略项报告，不改写原文件。

设置文件和快捷键文件使用 JSONC：扩展名仍为 `.json`，支持 `//`、`/* ... */` 注释和末尾逗号。打开用户设置命令会补全全部设置的默认值，并为每项添加中文说明及默认值注释；已有值、自写注释和未知字段保留，补全内容可撤销，保存后写入文件。默认值、用户设置、工作区设置按顺序覆盖；删除配置项后恢复下层设置或默认值。语言服务提供设置说明悬停、补全和校验，JSONC 格式化会保留注释。普通 JSON 文件仍进行严格校验。

HTML/CSS/JSON 的 Microsoft 语言服务随应用提供，需要 Node。JS/TS 工具按需安装；项目使用 TypeScript 7 之前的版本时使用项目 tsserver 与兼容 LSP。Rust 使用项目工具链的 rust-analyzer / rustfmt。

首次打开 JS/TS 文件提示缺少语言工具时，按 `Ctrl+Shift+P` 执行 `Language Tools: Install JavaScript/TypeScript Tools`。该命令会下载校验并安装 Node.js 和语言工具，成功后自动重新连接已打开文件的语言服务；不会安装或修改项目依赖。命令 `Language Tools: Install Verified Node.js Runtime` 可单独安装 Node.js，成功后同样自动重新连接；`Language: Restart Language Services` 可手动重新连接。安装失败保留已有工具。首次离线运行需预先准备工具或配置路径；本环境的应用内下载成功路径尚未验证。

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
npm test
npm run test:languages
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

真实桌面端测试需要 `tauri-driver` 和匹配 WebView2 版本的 EdgeDriver；先启动 `tauri-driver --port 4446 --native-driver <msedgedriver.exe 路径>`，然后执行 `npm run test:e2e`，或 `node tools/verify-desktop.mjs --release` 验证发行 exe。脚本创建隔离 fixture、便携数据目录并模拟崩溃，不使用个人工作区文件。

Trees 官方 skill 已通过 `npx skills add pierrecomputer/pierre --skill trees` 安装到 `.agents/skills/trees`，集成使用官方 React、prepared input、主题和交互 API。依赖锁定在 npm / Cargo lockfile；第三方许可在 [docs/licenses](docs/licenses/)，发行资源带有完整 notices。重新生成清单用 `node tools/notices.mjs`。
