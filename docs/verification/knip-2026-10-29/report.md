# LiteCode Knip 检查报告

> 后续清理已完成：见 [核查、实际修改、保留依据与验证结果](./cleanup.md)。以下为清理前的原始扫描报告。

日期：2026-10-29（Asia/Shanghai）  
版本：Knip 6.42.1 · Node.js 24.12.0 · npm 11.6.2  
HEAD：`dbc4626bd580ec9892a124e6cea9a56131d04b60`；扫描开始时工作区干净。

## 结果

默认扫描得到 **86 条提示**；沿用历史前端配置扫描得到 **21 条提示**。两次退出码均为 **1**，stderr 均为空，JSON 结果可正常解析。结果是静态分析候选，尚未逐项验证可删除性。

| 类别                       | 默认扫描 | 前端配置扫描 |
| -------------------------- | -------: | -----------: |
| 疑似未使用文件             |       52 |            0 |
| 疑似未使用生产依赖         |        2 |            2 |
| 疑似未使用开发依赖         |        9 |            2 |
| 未声明依赖（按报告位置计） |        9 |            6 |
| 未使用值导出               |        8 |            7 |
| 未使用类型导出             |        4 |            4 |
| 未声明命令                 |        2 |            0 |
| 无法解析的导入             |        0 |            0 |
| **总计**                   |   **86** |       **21** |

其他类别（重复导出、枚举成员、命名空间成员、catalog、catalogReferences、optionalPeerDependencies）均为 0。两列存在重叠，不应相加。

## 范围与判断限制

- 默认扫描没有自定义配置，按 Knip 默认规则和自动启用的插件分析根项目；不等同于完整审计所有子项目、Rust/Cargo 或运行时资源。
- 前端配置直接复制自 `../knip-2026-10-21/knip.config.json`：以 HTML / 前端入口和 `src` 为主，排除 `tools/**`、`src-tauri/**`，并忽略配置中列出的 8 项工具依赖。插件仍会分析 npm scripts、Vite / Vitest 配置，因此结果包含 `vitest.config.ts`。
- 默认扫描的 52 个文件包含独立工具脚本、打包产物和网站资源。独立执行、字符串路径、文件复制等使用方式可能没有被识别，不建议据此批量删除。
- `monaco-languages` 由 `src/editor/monaco.ts:130–184` 的 `import.meta.glob` 和运行时路径加载，`vite.config.ts` 也处理其解析；该依赖提示应保留并作为静态分析盲点记录。
- Vue / TypeScript 语言工具通过 `tools/build-tools.mjs` 的包复制逻辑和 `src-tauri/src/tools.rs` 的路径加载使用；前端配置中的 Vue 两项提示不能直接作为删除依据。
- `tools/trees/InlineEditInput.js` 被 `tools/patch-trees-creation.mjs` 复制进树组件依赖后运行，其中 `preact` 的归属需要按最终执行位置核对。
- `taskkill.exe`、`tar.exe` 是脚本调用的系统命令，不是应直接补装的 npm 包。

## 优先核对的未声明依赖

前端配置扫描报告 6 个位置，涉及 5 个不同的包：`vscode-jsonrpc`、`vscode`、`@codingame/monaco-vscode-files-service-override`、`@codingame/monaco-vscode-languages-service-override`、`vscode-languageserver-protocol`。默认扫描另有 `playwright` 的 2 个位置和 `preact` 的 1 个位置。

建议先核对这些直接导入与清单声明是否一致，尤其注意 `vscode` 的 alias 语义和 Codingame 包版本配套。未使用导出优先核对是否只需取消 `export`，不要直接删除模块内仍使用的实现。

## 默认扫描完整明细

### 疑似未使用文件（52）

| 文件 / 位置                                    | 名称                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| `tools/benchmark-explorer-model.mjs`           | `tools/benchmark-explorer-model.mjs`           |
| `tools/capture-inline-conflicts-reference.mjs` | `tools/capture-inline-conflicts-reference.mjs` |
| `tools/capture-website.mjs`                    | `tools/capture-website.mjs`                    |
| `tools/explorer-fixture.mjs`                   | `tools/explorer-fixture.mjs`                   |
| `tools/notices.mjs`                            | `tools/notices.mjs`                            |
| `tools/report-verification.mjs`                | `tools/report-verification.mjs`                |
| `tools/verify-breadcrumbs.mjs`                 | `tools/verify-breadcrumbs.mjs`                 |
| `tools/verify-config-syntax.mjs`               | `tools/verify-config-syntax.mjs`               |
| `tools/verify-conflicts-desktop.mjs`           | `tools/verify-conflicts-desktop.mjs`           |
| `tools/verify-document-backup.mjs`             | `tools/verify-document-backup.mjs`             |
| `tools/verify-editor-deletion.mjs`             | `tools/verify-editor-deletion.mjs`             |
| `tools/verify-editor-status.mjs`               | `tools/verify-editor-status.mjs`               |
| `tools/verify-editor-tabs.mjs`                 | `tools/verify-editor-tabs.mjs`                 |
| `tools/verify-explorer-creation-desktop.mjs`   | `tools/verify-explorer-creation-desktop.mjs`   |
| `tools/verify-explorer-creation.mjs`           | `tools/verify-explorer-creation.mjs`           |
| `tools/verify-explorer-editor-drag.mjs`        | `tools/verify-explorer-editor-drag.mjs`        |
| `tools/verify-explorer-large.mjs`              | `tools/verify-explorer-large.mjs`              |
| `tools/verify-explorer-moves-desktop.mjs`      | `tools/verify-explorer-moves-desktop.mjs`      |
| `tools/verify-explorer-moves.mjs`              | `tools/verify-explorer-moves.mjs`              |
| `tools/verify-explorer-offscreen-creation.mjs` | `tools/verify-explorer-offscreen-creation.mjs` |
| `tools/verify-explorer-paste.mjs`              | `tools/verify-explorer-paste.mjs`              |
| `tools/verify-explorer-scroll.mjs`             | `tools/verify-explorer-scroll.mjs`             |
| `tools/verify-explorer-sync.mjs`               | `tools/verify-explorer-sync.mjs`               |
| `tools/verify-external-drops-desktop.mjs`      | `tools/verify-external-drops-desktop.mjs`      |
| `tools/verify-fonts.mjs`                       | `tools/verify-fonts.mjs`                       |
| `tools/verify-formatter-trust.mjs`             | `tools/verify-formatter-trust.mjs`             |
| `tools/verify-git-cancel.mjs`                  | `tools/verify-git-cancel.mjs`                  |
| `tools/verify-git-panes.mjs`                   | `tools/verify-git-panes.mjs`                   |
| `tools/verify-inline-conflicts.mjs`            | `tools/verify-inline-conflicts.mjs`            |
| `tools/verify-languages.mjs`                   | `tools/verify-languages.mjs`                   |
| `tools/verify-layout.mjs`                      | `tools/verify-layout.mjs`                      |
| `tools/verify-line-blame.mjs`                  | `tools/verify-line-blame.mjs`                  |
| `tools/verify-markdown.mjs`                    | `tools/verify-markdown.mjs`                    |
| `tools/verify-media.mjs`                       | `tools/verify-media.mjs`                       |
| `tools/verify-planning-trust.mjs`              | `tools/verify-planning-trust.mjs`              |
| `tools/verify-quick-open.mjs`                  | `tools/verify-quick-open.mjs`                  |
| `tools/verify-recovery-desktop.mjs`            | `tools/verify-recovery-desktop.mjs`            |
| `tools/verify-release.mjs`                     | `tools/verify-release.mjs`                     |
| `tools/verify-search-view.mjs`                 | `tools/verify-search-view.mjs`                 |
| `tools/verify-settings.mjs`                    | `tools/verify-settings.mjs`                    |
| `tools/verify-tab-menu.mjs`                    | `tools/verify-tab-menu.mjs`                    |
| `tools/verify-terminal-desktop.mjs`            | `tools/verify-terminal-desktop.mjs`            |
| `tools/verify-updates-desktop.mjs`             | `tools/verify-updates-desktop.mjs`             |
| `tools/verify-vue.mjs`                         | `tools/verify-vue.mjs`                         |
| `tools/verify-website.mjs`                     | `tools/verify-website.mjs`                     |
| `tools/verify-workspace-status.mjs`            | `tools/verify-workspace-status.mjs`            |
| `tools/web-language-server.mjs`                | `tools/web-language-server.mjs`                |
| `src-tauri/tools/web-language-server.cjs`      | `src-tauri/tools/web-language-server.cjs`      |
| `website/assets/language.js`                   | `website/assets/language.js`                   |
| `website/assets/main.js`                       | `website/assets/main.js`                       |
| `website/assets/style.css`                     | `website/assets/style.css`                     |
| `website/assets/theme.js`                      | `website/assets/theme.js`                      |

### 疑似未使用生产依赖（2）

| 文件 / 位置       | 名称                        |
| ----------------- | --------------------------- |
| `package.json:25` | `@tauri-apps/plugin-dialog` |
| `package.json:38` | `monaco-languages`          |

### 疑似未使用开发依赖（9）

| 文件 / 位置       | 名称                                 |
| ----------------- | ------------------------------------ |
| `package.json:47` | `@playwright/test`                   |
| `package.json:55` | `@vue/language-server`               |
| `package.json:56` | `@vue/typescript-plugin`             |
| `package.json:64` | `typescript-language-server`         |
| `package.json:67` | `vscode-css-languageservice`         |
| `package.json:68` | `vscode-html-languageservice`        |
| `package.json:69` | `vscode-json-languageservice`        |
| `package.json:70` | `vscode-languageserver`              |
| `package.json:71` | `vscode-languageserver-textdocument` |

### 未声明依赖（按报告位置计）（9）

| 文件 / 位置                        | 名称                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `tools/verify-git.mjs:6`           | `playwright`                                          |
| `tools/verify-git-ignore.mjs:6`    | `playwright`                                          |
| `tools/trees/InlineEditInput.js:1` | `preact`                                              |
| `vitest.config.ts:13`              | `vscode-jsonrpc`                                      |
| `src/editor/monaco.ts:4`           | `@codingame/monaco-vscode-languages-service-override` |
| `src/editor/languages.ts:8`        | `vscode-jsonrpc`                                      |
| `src/editor/languages.ts:10`       | `vscode`                                              |
| `src/editor/languages.ts:16`       | `@codingame/monaco-vscode-files-service-override`     |
| `src/editor/languages.ts:453`      | `vscode-languageserver-protocol`                      |

### 未使用值导出（8）

| 文件 / 位置                        | 名称                   |
| ---------------------------------- | ---------------------- |
| `tools/setup-updater.mjs:10`       | `setupUpdater`         |
| `src/core/commands.ts:75`          | `editorTarget`         |
| `src/core/commands.ts:117`         | `quick`                |
| `src/core/commands.ts:194`         | `openFile`             |
| `src/editor/font.ts:5`             | `defaultFontLigatures` |
| `src/explorer/workspaceTree.ts:10` | `resetWorkspaceTree`   |
| `src/search/search.ts:65`          | `resetSearchTabs`      |
| `src/utils/media.ts:15`            | `zoomLevels`           |

### 未使用类型导出（4）

| 文件 / 位置                      | 名称             |
| -------------------------------- | ---------------- |
| `src/types/types.ts:1`           | `AppError`       |
| `src/types/types.ts:24`          | `FileKind`       |
| `src/editor/mergeConflicts.ts:2` | `ConflictRegion` |
| `src/terminal/state.ts:29`       | `TerminalTab`    |

### 未声明命令（2）

| 文件 / 位置                  | 名称           |
| ---------------------------- | -------------- |
| `tools/verify-desktop.mjs`   | `taskkill.exe` |
| `tools/package-portable.mjs` | `tar.exe`      |

## 复现与原始记录

在仓库根目录执行：

```powershell
npm exec --yes --package=knip@6.42.1 -- knip --no-progress --reporter json
npm exec --yes --package=knip@6.42.1 -- knip --config docs/verification/knip-2026-10-29/knip.config.json --no-progress --reporter json
```

- 默认扫描：[JSON](./baseline.json) · [stderr](./baseline-stderr.txt) · [退出码](./baseline-exit-code.txt)
- 前端扫描：[JSON](./frontend.json) · [配置](./knip.config.json) · [stderr](./frontend-stderr.txt) · [退出码](./frontend-exit-code.txt)
- [机器可读汇总](./summary.json)

本次仅生成检查报告，未执行 `--fix`，未改动源码、依赖清单或锁文件。未运行构建、单元测试或桌面回归；实际清理后需验证对应功能。
