# LiteCode Knip 检查报告（不含 tools）

日期：2026-10-21（Asia/Shanghai）  
版本：Knip 6.42.1 · Node.js 24.12.0 · npm 11.6.2  
HEAD：`61de77c96a28a92258953d352aa2a51fb97656cd`（包含工作区未提交修改）

## 结论

按要求排除 `tools` 后重新扫描，得到 **16 条提示**。建议优先补全 **4 个直接导入依赖**，再处理多余导出和未使用类型。没有发现前端未使用文件或无法解析的导入。

| 类别 | 数量 | 核对结果 |
|---|---:|---|
| 未声明依赖 | 4 | 源码直接导入，根 package.json 未声明；目前依赖传递安装。 |
| 疑似未使用依赖 | 2 | 1 项可移除候选，1 项为语法资源加载误报。 |
| 未使用值导出 | 8 | 7 项仍在模块内使用，可考虑取消 export；1 项有范围外动态调用。 |
| 未使用类型导出 | 2 | 1 项可考虑取消 export，1 项为可删除类型候选。 |
| 未使用文件 / 无法解析导入 / 未声明命令 | 0 | 本次范围内没有相应提示。 |
| **总计** | **16** | 静态提示，不等同于已确认的运行故障。 |

## 1. 优先处理：4 个直接导入依赖未声明

全部位于 `src/editor/languages.ts`。当前 npm 依赖树可以解析，但源码实际使用的包没有在根清单明确约束；上游依赖调整或安装布局变化后存在解析失败风险。

| 包 | 行 | 当前安装版本 | 建议 |
|---|---:|---|---|
| `vscode-jsonrpc` | 8 | 9.0.3 | 显式声明匹配当前 LSP 协议栈的直接依赖。 |
| `vscode` | 10 | `npm:@codingame/monaco-vscode-extension-api@37.6.1` | 保留当前 npm alias 语义声明，避免安装成不同的 vscode 包。 |
| `@codingame/monaco-vscode-files-service-override` | 16 | 37.6.1 | 显式声明，与现有 Codingame 包版本一致。 |
| `vscode-languageserver-protocol` | 329 | 3.18.4 | 显式声明匹配当前协议栈的版本。 |

已通过现有 node_modules 的 package.json、npm ls 和 npm explain 核对来源：这些包由 monaco-languageclient、Monaco API 或 LSP 相关包间接提供。本次没有验证全新安装或其他包管理器会实际失败。

## 2. 10 个未使用导出：不要直接删除函数

“未使用导出”表示没有识别到模块外消费者。下列 7 个值和 1 个类型在各自文件内仍被使用，适合取消 export，保留实现。

| 文件 | 行 | 导出 | 建议 |
|---|---:|---|---|
| `src/editor/languages.ts` | 171 | `formatModelText` | 本文件格式化逻辑使用；可取消 export。 |
| `src/core/commands.ts` | 57 | `editorTarget` | 本文件命令处理逻辑使用；可取消 export。 |
| `src/core/commands.ts` | 99 | `quick` | 本文件多个命令使用；可取消 export。 |
| `src/core/commands.ts` | 131 | `openFile` | 本文件注册为打开文件命令处理器；可取消 export。 |
| `src/explorer/workspaceTree.ts` | 10 | `resetWorkspaceTree` | 本文件工作区重置逻辑使用；可取消 export。 |
| `src/utils/media.ts` | 14 | `zoomLevels` | 本文件缩放计算使用；可取消 export。 |
| `src/components/EditorGroup.tsx` | 675 | `compareDisk` | 本文件按钮点击处理器使用；可取消 export。 |
| `src/types/types.ts` | 9 | `FileKind` | 本文件 FileInfo、Doc 类型使用；可取消 export。 |

另外两项：

| 文件 | 行 | 导出 | 核对结论 |
|---|---:|---|---|
| `src/types/types.ts` | 1 | `AppError` | 在前端源码仅发现定义，可删除类型候选。 |
| `src/editor/documents.ts` | 79 | `model` | 前端源码无消费者，但已知有范围外动态调用；保留导出。本次不评价该调用方。 |

## 3. 两项依赖提示

| 依赖 | 清单行 | 核对结论 | 建议 |
|---|---:|---|---|
| `@tauri-apps/plugin-dialog` | 27 | 没有前端导入。前端通过 pick_path IPC 调用原生文件对话框。 | npm 前端包是可移除候选。此结论不涉及 Rust 的对话框插件和初始化。 |
| `monaco-languages` | 34 | `src/editor/monaco.ts:117–169` 使用 import.meta.glob 和 /node_modules/monaco-languages/ 路径加载语法；Vite 配置有对应解析逻辑。 | **误报，保留。** 删除会影响语法高亮资源。 |

## 范围与复现

检查 src 中的 TS/TSX、CSS/JSON、HTML 入口和 Vite 配置，保留前端单元测试。排除 tools/** 与 src-tauri/** 的问题提示；不将生成产物纳入未使用文件检查。仅供工具链脚本使用的 8 项依赖从依赖清理建议中排除，详见配置的 ignoreDependencies。

Knip 插件仍可能沿 npm scripts 和 Vite 的导入分析辅助文件；本配置通过限定 project / entry 并设置 ignore，使这些文件的诊断不进入报告。这个范围排除不会自动把它们依赖的包视为可删除。配置语义见 [Knip 配置文档](https://knip.dev/reference/configuration)。

```powershell
npm exec --yes --package=knip@6.42.1 -- knip --config docs/verification/knip-2026-10-21/knip.config.json --no-progress --reporter json
```

退出码为 **1**，表示发现提示；stderr 为空，扫描正常完成。未运行 --fix，本任务只新增报告目录，未修改 package.json、锁文件或业务源码。

扫描期间工作区另有未提交修改；本报告对应最终扫描时的文件状态，源码位置可能随并行编辑变化，相关 SHA-256 和时间保存在 summary.json。此前较大范围扫描的 baseline / calibrated 文件仅作为历史原始记录，不计入本报告。

未运行构建、单元测试、浏览器或桌面回归，也未审计 Rust/Cargo。Knip 对运行时路径与跨语言调用的识别有限，落实删除建议后仍需运行对应验证。

[原始 JSON](./frontend.json) · [检查配置](./knip.config.json) · [汇总](./summary.json) · [stderr](./frontend-stderr.txt) · [退出码](./frontend-exit-code.txt)
