# Knip 核查与清理结果

日期：2026-10-29（Asia/Shanghai）。对应 HEAD `dbc4626bd580ec9892a124e6cea9a56131d04b60` 上的工作区修改。

## 结果

**修复原报告中的 23 条实际清理项，原始规则下提示从 86 降至 63；配置真实入口和动态加载例外后，Knip 为 0 条提示、退出码 0。** 原报告标记的 52 个文件全部保留；另删除了一个确认无用的临时文本文件。

| 检查范围            | 清理前 | 清理后 | 说明                                                                          |
| ------------------- | -----: | -----: | ----------------------------------------------------------------------------- |
| 原默认规则          |     86 |     63 | 用空配置复现原规则，排除新配置影响。                                          |
| 原前端配置          |     21 |      4 | 剩余 monaco-languages、Vue 两包及 playwright 均属于动态资源或范围外工具依赖。 |
| 新根配置 knip.jsonc |      — |      0 | 纳入实际脚本、网站、复制模块和 Vite URL 解析；动态依赖、系统命令逐项注释。    |

## 实际修改

- **9 条未声明依赖**：补齐 5 个前端直接依赖（Codingame 两个 override、vscode alias、vscode-jsonrpc、vscode-languageserver-protocol），以及工具使用的 playwright / preact。全部沿用现有安装版本；9 个报告位置涉及 7 个包。
- **2 个无用包**：移除没有任何前端导入的 @tauri-apps/plugin-dialog；移除没有测试框架消费者的 @playwright/test，直接声明脚本实际导入的 playwright。Rust 的 dialog 插件与 pick_path IPC 保留。
- **8 个多余值导出**：editorTarget、quick、openFile、defaultFontLigatures、resetWorkspaceTree、resetSearchTabs、zoomLevels、setupUpdater 仅在本模块调用，取消 export 并保留实现。
- **4 个类型导出**：删除在 src / tools 中仅有定义的 AppError；FileKind、ConflictRegion、TerminalTab 仍在各自模块使用，仅取消 export。
- **1 个临时文件**：删除 docs/verification/test.txt。原内容仅为 test，删除前仓库检索没有找到路径引用，脚本检索没有发现生成或消费该文件的约定。
- 许可证索引及两份 notices 仅移除本次删除的两个 npm 包条目；没有纳入本地依赖树与历史清单的其他差异。

锁文件核对：仅删除 @playwright/test 与 @tauri-apps/plugin-dialog 的安装记录，其他现有包的锁定记录逐项对比保持一致。新增的是直接声明，没有升级其版本。

## 保留文件的逐项核查

以下 52 个文件均已核查。直接引用、功能职责、内容哈希及未改动断言另存于 [file-audit.json](./file-audit.json)。有独立 CLI 验证职责的脚本，即使没有 npm script 或模块消费者，也不按死文件删除。

| 文件                                           | 保留依据                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tools/benchmark-explorer-model.mjs`           | EXPLORER_PERFORMANCE.md 记录的手动基准测试入口，使用 LITECODE_BENCH_ROOT。                              |
| `tools/capture-inline-conflicts-reference.mjs` | docs/inline-conflicts.md 记录的 VS Code 冲突渲染对照入口，包含颜色和字体断言。                          |
| `tools/capture-website.mjs`                    | docs/website.md 记录的真实桌面截图入口，生成网站截图资源。                                              |
| `tools/explorer-fixture.mjs`                   | 被 breadcrumbs、editor、explorer 等 10 份浏览器验证脚本直接导入的共享 IPC fixture。                     |
| `tools/notices.mjs`                            | 依赖许可证和 inventory 生成入口，输出 docs/licenses 与打包 notices。                                    |
| `tools/report-verification.mjs`                | 读取 verify-desktop / package-portable 产出的现有记录，生成 PERFORMANCE.md 和 UI 环境记录。             |
| `tools/verify-breadcrumbs.mjs`                 | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-config-syntax.mjs`               | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-conflicts-desktop.mjs`           | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-document-backup.mjs`             | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-editor-deletion.mjs`             | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-editor-status.mjs`               | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-editor-tabs.mjs`                 | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-creation-desktop.mjs`   | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-creation.mjs`           | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-editor-drag.mjs`        | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-large.mjs`              | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-moves-desktop.mjs`      | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-moves.mjs`              | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-offscreen-creation.mjs` | 被 verify-explorer-creation.mjs 和其 desktop 版本直接导入的虚拟滚动验证辅助模块。                       |
| `tools/verify-explorer-paste.mjs`              | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-scroll.mjs`             | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-explorer-sync.mjs`               | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-external-drops-desktop.mjs`      | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-fonts.mjs`                       | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-formatter-trust.mjs`             | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-git-cancel.mjs`                  | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-git-panes.mjs`                   | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-inline-conflicts.mjs`            | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-languages.mjs`                   | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-layout.mjs`                      | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-line-blame.mjs`                  | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-markdown.mjs`                    | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-media.mjs`                       | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-planning-trust.mjs`              | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-quick-open.mjs`                  | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-recovery-desktop.mjs`            | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-release.mjs`                     | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-search-view.mjs`                 | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-settings.mjs`                    | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-tab-menu.mjs`                    | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-terminal-desktop.mjs`            | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-updates-desktop.mjs`             | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-vue.mjs`                         | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-website.mjs`                     | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/verify-workspace-status.mjs`            | 独立执行的功能回归检查入口，保留当前功能的断言与隔离 fixture；不要求被产品入口导入。                    |
| `tools/web-language-server.mjs`                | tools/build-tools.mjs 的 esbuild 入口，生成 Web 语言服务。                                              |
| `src-tauri/tools/web-language-server.cjs`      | Web 语言服务生成产物；由 Tauri bundle.resources 打包，src-tauri/src/tools.rs 在运行时启动。             |
| `website/assets/language.js`                   | 中英文网站 HTML 的 script/link 标签直接加载；GitHub Pages 工作流发布 website 目录，网站浏览器验证通过。 |
| `website/assets/main.js`                       | 中英文网站 HTML 的 script/link 标签直接加载；GitHub Pages 工作流发布 website 目录，网站浏览器验证通过。 |
| `website/assets/style.css`                     | 中英文网站 HTML 的 script/link 标签直接加载；GitHub Pages 工作流发布 website 目录，网站浏览器验证通过。 |
| `website/assets/theme.js`                      | 中英文网站 HTML 的 script/link 标签直接加载；GitHub Pages 工作流发布 website 目录，网站浏览器验证通过。 |

## 新配置的依据

- 独立 verify、capture、benchmark、notices、report 命令作为入口。被其他验证入口导入的 Git / offscreen helpers 仍按普通模块分析，没有将所有 tools 文件一律标记成入口。
- 静态网站的 language、theme、main 脚本和 style.css 明确对应中英文 HTML 标签；额外列入口是为了补足 Knip 对普通 script/link 标签的识别。
- InlineEditInput.js 是 patch-trees-creation.mjs 复制进 @pierre/trees 的运行模块；preact 已作为直接开发依赖声明。
- /src/* 映射到 src/*，用于解析验证脚本在浏览器 page.evaluate 中发起的 Vite URL 导入，没有整体忽略 unresolved。
- 四个动态依赖例外：monaco-languages 经 import.meta.glob 加载；Vue 两包、typescript-language-server 经 build-tools 文件复制及 Rust 路径启动。其余 Web 语言服务依赖通过补充源入口正常识别。
- 四个外部命令例外：taskkill.exe、tar.exe、where.exe 为 Windows 工具；ffmpeg 是截图/演示视频流程的外部工具。
- project 覆盖 src、tools、website 及根 JS/TS/HTML；不将 src-tauri/tools 的生成代码当作未使用源码，生成产物的用途仍单独核查并保留。未整体忽略 files、exports、types 或 unlisted 类别。

## 验证

| 检查                            | 结果                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Knip 6.42.1（根配置）           | 0 条，退出码 0，stderr 为空。                                                                                                   |
| npm run lint                    | 通过。                                                                                                                          |
| npm test                        | 42 个测试文件、702 个测试全部通过。                                                                                             |
| Oxfmt（修改的源码、配置）       | 通过。                                                                                                                          |
| npm run build                   | 通过；仍有依赖外置、chunk 大小及动态导入等打包提示。                                                                            |
| npm run build:tools             | 通过。                                                                                                                          |
| node tools/verify-website.mjs   | 通过，覆盖中英文、资源、语言切换、主题和响应布局。                                                                              |
| node tools/verify-languages.mjs | 第一次 Vue tsserver 进程以 3221225794 退出；停止其他构建/浏览器验证后单独完整重跑，9 个用例全部通过。未确认首次进程失败的根因。 |

语言验证覆盖 JSON/JSONC/HTML/CSS、bundled/workspace TypeScript 及 Vue template / TypeScript 桥接；历史 language-server-results.json 已按原字节恢复，本次结果保存在当前目录。没有执行完整桌面端到端回归或重新构建 Rust 安装包。

## 原始结果与复现

- [清理后根配置结果](./after.json) · [退出码](./after-exit-code.txt) · [stderr](./after-stderr.txt)
- [清理后原默认规则结果](./after-baseline.json) · [空配置](./baseline.knip.json)
- [清理后原前端规则结果](./after-frontend.json) · [历史前端配置](./knip.config.json)
- [清理前报告](./report.md) · [汇总](./summary.json)
- [单元测试](./tests-stdout.txt) · [构建 stdout](./build-stdout.txt) / [stderr](./build-stderr.txt)
- [网站验证](./website-stdout.txt) · [语言重跑结果](./language-server-results.json) · [重跑 stdout](./languages-retry-stdout.txt) · [首次失败](./languages-stderr.txt)

```powershell
npm exec --yes --package=knip@6.42.1 -- knip --no-progress --reporter json
npm exec --yes --package=knip@6.42.1 -- knip --config docs/verification/knip-2026-10-29/baseline.knip.json --no-progress --reporter json
npm exec --yes --package=knip@6.42.1 -- knip --config docs/verification/knip-2026-10-29/knip.config.json --no-progress --reporter json
```
