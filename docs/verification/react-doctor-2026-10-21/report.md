# LiteCode · React Doctor 诊断报告

> 2026-10-21（Asia/Shanghai） · React Doctor 0.9.18 · 全量静态扫描

## 1. 一页结论

本次全量扫描完成，主要诊断集中在性能与 React Compiler 优化覆盖范围。29 条 error 中有 24 条属于性能类别，其中 9 条是编译器暂不支持语法。错误级别不等于已确认的运行故障或安全漏洞。建议先处理渲染纯度、状态写入与输入边界，再验证键盘交互，随后按实际测量推进性能和结构调整。

| 扫描文件 | 诊断总数 | error | warning | 涉及文件 | 规则种类 |
|---:|---:|---:|---:|---:|---:|
| 92 | 85 | 29 | 56 | 25 | 26 |

[打开可筛选的 HTML 报告](./report.html) · [原始 JSON](./raw-report.json)

## 2. 分类概览

| 分类 | 总数 | error | warning | 占比 |
|---|---:|---:|---:|---:|
| 性能与编译器 | 50 | 24 | 26 | 58.8% |
| 可维护性 | 14 | 0 | 14 | 16.5% |
| 正确性与健壮性 | 10 | 3 | 7 | 11.8% |
| 无障碍与交互 | 6 | 0 | 6 | 7.1% |
| 安全边界 | 5 | 2 | 3 | 5.9% |

### 建议处理顺序

| 批次 | 方向 | 重点 | 验收方式（后续工作） |
|---|---|---|---|
| 1 | 状态与渲染纯度 | EditorGroup 的 group.views 写入；Explorer/MediaPreview 的 render 中 Ref 写入 | 切换标签、恢复滚动位置、图片缩放与根目录切换；检查旧闭包和重复渲染行为。 |
| 2 | 输入边界与资源生命周期 | 拖拽 JSON、useExternalDrop 异步分配与清理 | 非法/空载荷；拖拽中切换工作区或卸载；超时与取消后的资源释放。 |
| 3 | 键盘和辅助技术 | 标签页关闭按钮、搜索树节点、媒体预览动作 | 仅用键盘完成选择/关闭/导航；验证可访问名称、焦点和屏幕阅读器语义。 |
| 4 | 编译器与性能 | QuickOpen 缓存；串行任务与线性查找；Monaco 加载 | 以真实大目录和快速输入建立基线，检查响应时间、取消语义、初始化与冷启动。 |
| 5 | 结构整理与告警治理 | 大组件拆分；Compiler todo；工具脚本与 Worker 告警 | 合并重复根因；只对有充分场景依据的告警做最小范围豁免并留下理由。 |

优先级分布：P1 21 条；P2 48 条；P3 16 条。它们是处理顺序，不会覆盖原始严重级别。

## 3. 复核发现与适用场景

- **9 条编译器 todo**：所有 help 都明确标注未支持的编译阶段语法或重排限制。应视为优化覆盖范围问题，未据此确认业务缺陷。保留 finally 的释放语义。 参见 [src/components/Explorer.tsx:192](../../../src/components/Explorer.tsx)。
- **2 条元数据执行 error**：notices:38 是固定 cargo metadata 调用，package-portable:34 是固定本地 PowerShell 脚本调用。当前片段不支持“导入元数据被当作代码执行”的结论，倾向场景误报，需保留信任边界审查。 参见 [tools/notices.mjs:38](../../../tools/notices.mjs)。
- **2 条消息来源 warning**：Explorer 的 w 是专用 Worker，另一个命中在 Worker 测试桩。跨窗口 origin 校验建议不直接适用。 参见 [src/components/Explorer.tsx:550](../../../src/components/Explorer.tsx)。
- **1 条定时器清理 error**：useExternalDrop 已通过 clear()、finally 和 Effect return 释放资源；需验证异步竞态，尚不能认定泄漏。 参见 [src/hooks/useExternalDrop.ts:194](../../../src/hooks/useExternalDrop.ts)。
- **DOM 与 props 写入需区别**：group.views 的直接写入与 scrollbar 事件中设置 element.scrollLeft 属于不同场景；后者不应因工具建议而直接迁移到 React 状态。 参见 [src/components/EditorGroup.tsx:581](../../../src/components/EditorGroup.tsx)。
- **内部导航与 key 建议**：Markdown 链接调用 follow；字符高亮和路径片段使用索引 key 风险较低。保留原始诊断，按是否有状态、是否重排判断。 参见 [src/components/MarkdownPreview.tsx:107](../../../src/components/MarkdownPreview.tsx)。

## 4. 各类规则与建议

### 性能与编译器（50 条）

#### 可变对象阻碍编译器优化 · 5 条 · error · P1

规则：`react-hooks-js/immutability`

EditorGroup:195/205 直接写入 group.views，应评估通过 store action 更新或改为明确的可变容器；581/588/601 涉及事件内 DOM 滚动，需单独验证编译器分析结果，不应直接改成 React 状态。

位置：[src/components/EditorGroup.tsx:195](../../../src/components/EditorGroup.tsx)、[src/components/EditorGroup.tsx:205](../../../src/components/EditorGroup.tsx)、[src/components/EditorGroup.tsx:581](../../../src/components/EditorGroup.tsx)、[src/components/EditorGroup.tsx:588](../../../src/components/EditorGroup.tsx)、[src/components/EditorGroup.tsx:601](../../../src/components/EditorGroup.tsx)。

#### 循环中串行等待 · 11 条 · warning · P2

规则：`react-doctor/async-await-in-loop`

逐项确认执行顺序、文件操作冲突、取消和错误语义。只有独立任务才考虑有上限的并发，不能机械替换为 Promise.all。

位置：[src/components/EditorGroup.tsx:250](../../../src/components/EditorGroup.tsx)、[src/components/Explorer.tsx:809](../../../src/components/Explorer.tsx)、[src/editor/documents.ts:491](../../../src/editor/documents.ts)、[src/editor/documents.ts:633](../../../src/editor/documents.ts)、[src/editor/documents.ts:931](../../../src/editor/documents.ts)、[src/editor/languages.ts:361](../../../src/editor/languages.ts)、[src/editor/languages.ts:408](../../../src/editor/languages.ts)、[src/editor/languages.ts:448](../../../src/editor/languages.ts)、[src/explorer/explorerClipboard.ts:108](../../../src/explorer/explorerClipboard.ts)、[src/explorer/externalDrop.ts:86](../../../src/explorer/externalDrop.ts)、[src/search/search.ts:338](../../../src/search/search.ts)。

#### 循环内重复线性查找 · 8 条 · warning · P2

规则：`react-doctor/js-set-map-lookups`

对大集合和高频调用评估 Set/Map；小列表需权衡索引构建成本。

位置：[src/components/EditorGroup.tsx:315](../../../src/components/EditorGroup.tsx)、[src/core/commands.ts:243](../../../src/core/commands.ts)、[src/editor/documents.ts:371](../../../src/editor/documents.ts)、[src/editor/documents.ts:375](../../../src/editor/documents.ts)、[src/editor/documents.ts:706](../../../src/editor/documents.ts)、[src/store/store.ts:97](../../../src/store/store.ts)、[src/store/store.ts:111](../../../src/store/store.ts)、[src/utils/keybindings.ts:11](../../../src/utils/keybindings.ts)。

#### Ref 初始化重复执行 · 1 条 · warning · P2

规则：`react-doctor/rerender-lazy-ref-init`

检查 Explorer 初始化成本；若成本明显，再采用可预测的惰性初始化。

位置：[src/components/Explorer.tsx:85](../../../src/components/Explorer.tsx)。

#### Ref 使用阻碍编译器优化 · 5 条 · error · P1

规则：`react-hooks-js/refs`

与渲染期 Ref 写入合并排查，另行检查 Explorer 惰性初始化、QuickOpen 回调闭包。不要按诊断条数重复实施修复。

位置：[src/components/Explorer.tsx:147](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:149](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:150](../../../src/components/Explorer.tsx)、[src/components/MediaPreview.tsx:170](../../../src/components/MediaPreview.tsx)、[src/components/QuickOpen.tsx:225](../../../src/components/QuickOpen.tsx)。

#### 编译器暂不支持的语法 · 9 条 · error · P3

规则：`react-hooks-js/todo`

9 条 help 明确提到 finally、try/throw、动态 import 或表达式重排限制。先作为优化覆盖范围记录；只有测出收益时才调整结构，保留资源释放与异常语义。

位置：[src/components/Explorer.tsx:192](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:282](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:409](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:741](../../../src/components/Explorer.tsx)、[src/components/Explorer.tsx:771](../../../src/components/Explorer.tsx)、[src/components/SearchView.tsx:152](../../../src/components/SearchView.tsx)、[src/hooks/useExternalDrop.ts:130](../../../src/hooks/useExternalDrop.ts)、[src/hooks/useExternalDrop.ts:134](../../../src/hooks/useExternalDrop.ts)、[src/hooks/useExternalDrop.ts:176](../../../src/hooks/useExternalDrop.ts)。

#### Effect 同步更新状态 · 4 条 · warning · P2

规则：`react-hooks-js/set-state-in-effect`

能派生的值直接计算；测量、浏览器 API 和外部系统同步需结合场景保留，先确认额外渲染是否有影响。

位置：[src/components/Explorer.tsx:692](../../../src/components/Explorer.tsx)、[src/components/MediaPreview.tsx:20](../../../src/components/MediaPreview.tsx)、[src/components/QuickOpen.tsx:157](../../../src/components/QuickOpen.tsx)、[src/hooks/useQuickFiles.ts:57](../../../src/hooks/useQuickFiles.ts)。

#### 手工缓存无法被编译器保留 · 5 条 · error · P2

规则：`react-hooks-js/preserve-manual-memoization`

QuickOpen 的依赖、可变闭包和 useMemo/useCallback 需统一梳理。109 同行有两条独立工具诊断，原样保留；不要直接删除缓存。

位置：[src/components/QuickOpen.tsx:95](../../../src/components/QuickOpen.tsx)、[src/components/QuickOpen.tsx:109](../../../src/components/QuickOpen.tsx)、[src/components/QuickOpen.tsx:109](../../../src/components/QuickOpen.tsx)、[src/components/QuickOpen.tsx:367](../../../src/components/QuickOpen.tsx)、[src/components/QuickOpen.tsx:387](../../../src/components/QuickOpen.tsx)。

#### JSON 往返深拷贝 · 1 条 · warning · P3

规则：`react-doctor/no-json-parse-stringify-clone`

命中 editorLayout.test.ts 测试夹具，生产影响低。确认数据类型后才考虑 structuredClone。

位置：[src/editor/editorLayout.test.ts:81](../../../src/editor/editorLayout.test.ts)。

#### Monaco 静态导入体积建议 · 1 条 · warning · P2

规则：`react-doctor/prefer-dynamic-import`

本项目以编辑器为核心且有别名与语言服务集成。先测冷启动和产物体积，动态导入须处理初始化顺序与实例一致性。

位置：[src/editor/monaco.ts:1](../../../src/editor/monaco.ts)。

### 可维护性（14 条）

#### 组件控制流复杂 · 5 条 · warning · P2

规则：`react-doctor/no-high-complexity-react-function`

按职责拆分组件或 Hook，先处理高频修改区域。复杂度指标不代表已发生故障。

位置：[src/components/App.tsx:103](../../../src/components/App.tsx)、[src/components/EditorGroup.tsx:41](../../../src/components/EditorGroup.tsx)、[src/components/MediaPreview.tsx:10](../../../src/components/MediaPreview.tsx)、[src/components/QuickOpen.tsx:36](../../../src/components/QuickOpen.tsx)、[src/components/SearchView.tsx:22](../../../src/components/SearchView.tsx)。

#### 组件体积过大 · 5 条 · warning · P2

规则：`react-doctor/no-giant-component`

拆分独立视图、交互与状态逻辑，避免仅为行数拆出无意义组件。

位置：[src/components/App.tsx:103](../../../src/components/App.tsx)、[src/components/EditorGroup.tsx:41](../../../src/components/EditorGroup.tsx)、[src/components/Explorer.tsx:57](../../../src/components/Explorer.tsx)、[src/components/QuickOpen.tsx:36](../../../src/components/QuickOpen.tsx)、[src/components/SearchView.tsx:22](../../../src/components/SearchView.tsx)。

#### 组件文件混合导出 · 4 条 · warning · P2

规则：`react-doctor/only-export-components`

将独立工具导出移到模块中，改善 Fast Refresh 状态保留；它主要影响开发体验。

位置：[src/components/EditorGroup.tsx:673](../../../src/components/EditorGroup.tsx)、[src/components/Explorer.tsx:52](../../../src/components/Explorer.tsx)、[src/components/dialog.tsx:16](../../../src/components/dialog.tsx)、[src/components/dialog.tsx:58](../../../src/components/dialog.tsx)。

### 正确性与健壮性（10 条）

#### JSON 解析缺少边界保护 · 2 条 · warning · P1

规则：`react-doctor/no-unsafe-json-parse`

拖拽载荷应捕获解析错误并验证 id/from 类型和来源。settingsKey 来自内部设置序列化，优先确认其生成链路与输入不变量。

位置：[src/components/EditorGroup.tsx:295](../../../src/components/EditorGroup.tsx)、[src/hooks/useQuickFiles.ts:21](../../../src/hooks/useQuickFiles.ts)。

#### 索引用作列表 key · 4 条 · warning · P2

规则：`react-doctor/no-array-index-as-key`

动态业务列表采用稳定身份。字符高亮和无状态路径片段风险较低，不能把全部命中都认定为错位缺陷。

位置：[src/components/EditorGroup.tsx:447](../../../src/components/EditorGroup.tsx)、[src/components/EditorTabMenu.tsx:111](../../../src/components/EditorTabMenu.tsx)、[src/components/QuickOpen.tsx:547](../../../src/components/QuickOpen.tsx)、[src/components/SearchView.tsx:367](../../../src/components/SearchView.tsx)。

#### 渲染期间写入 Ref · 2 条 · error · P1

规则：`react-doctor/no-ref-current-in-render`

Explorer:147 与 MediaPreview:170 有直接赋值；评估移到提交阶段，验证事件回调仍能读取正确的最新值。

位置：[src/components/Explorer.tsx:147](../../../src/components/Explorer.tsx)、[src/components/MediaPreview.tsx:170](../../../src/components/MediaPreview.tsx)。

#### 链接默认跳转被拦截 · 1 条 · warning · P3

规则：`react-doctor/no-prevent-default`

MarkdownPreview 拦截后调用 follow，执行桌面内导航或外部打开，并非没有动作。保留链接语义，回归键盘激活、文件跳转与锚点。

位置：[src/components/MarkdownPreview.tsx:107](../../../src/components/MarkdownPreview.tsx)。

#### Effect 定时器清理待核验 · 1 条 · error · P1

规则：`react-doctor/effect-needs-cleanup`

源码已有 clear() 清理 hover/scroll，finally:194–197 清理批次 timeout，卸载时 abort 并调用 clear()。未确认泄漏；需验证卸载与异步完成竞态，不能盲目添加重复清理。

位置：[src/hooks/useExternalDrop.ts:21](../../../src/hooks/useExternalDrop.ts)。

### 无障碍与交互（6 条）

#### 交互控件嵌套 · 1 条 · warning · P1

规则：`react-doctor/html-no-nested-interactive`

将标签页选择与关闭动作的语义、焦点处理分开，验证键盘和屏幕阅读器行为。

位置：[src/components/EditorGroup.tsx:377](../../../src/components/EditorGroup.tsx)。

#### 非交互元素承载交互 · 2 条 · warning · P1

规则：`react-doctor/no-noninteractive-element-interactions`

确认容器是拖拽区域还是独立动作；为用户操作提供可聚焦入口、合适语义和键盘等价操作。

位置：[src/components/Explorer.tsx:848](../../../src/components/Explorer.tsx)、[src/components/MediaPreview.tsx:247](../../../src/components/MediaPreview.tsx)。

#### 静态元素缺少交互语义 · 1 条 · warning · P1

规则：`react-doctor/no-static-element-interactions`

检查 MediaPreview 点击区域语义与可聚焦替代控件，避免只补 role 而缺少完整键盘操作。

位置：[src/components/MediaPreview.tsx:211](../../../src/components/MediaPreview.tsx)。

#### 点击缺少键盘等价行为 · 1 条 · warning · P1

规则：`react-doctor/click-events-have-key-events`

检查 MediaPreview:247 是否已有全局或子控件等价操作；若无则补充键盘路径。

位置：[src/components/MediaPreview.tsx:247](../../../src/components/MediaPreview.tsx)。

#### 树节点焦点模型需检查 · 1 条 · warning · P1

规则：`react-doctor/interactive-supports-focus`

SearchView 使用父容器键盘处理，需确认 roving tabindex 或 aria-activedescendant 与可见节点同步，验证虚拟列表滚动和辅助技术。

位置：[src/components/SearchView.tsx:427](../../../src/components/SearchView.tsx)。

### 安全边界（5 条）

#### 消息来源检查启发式告警 · 2 条 · warning · P3

规则：`react-doctor/postmessage-origin-risk`

Explorer 使用专用 Worker；verify-quick-open 也是 Worker 测试桩。当前片段不属于跨窗口 message 接收，倾向场景误报；需保留 Worker 来源与数据结构校验。

位置：[src/components/Explorer.tsx:550](../../../src/components/Explorer.tsx)、[tools/verify-quick-open.mjs:48](../../../tools/verify-quick-open.mjs)。

#### 元数据执行风险启发式告警 · 2 条 · error · P3

规则：`react-doctor/import-metadata-execution-risk`

notices 执行固定 cargo metadata 再解析输出；package-portable 执行固定本地 ps1 并传独立参数。片段未见元数据当代码执行，倾向场景误报；仍需审查本地脚本与参数信任来源。

位置：[tools/notices.mjs:38](../../../tools/notices.mjs)、[tools/package-portable.mjs:34](../../../tools/package-portable.mjs)。

#### 本地驱动端点风险提示 · 1 条 · warning · P3

规则：`react-doctor/local-rpc-native-bridge-risk`

命中桌面自动化验证脚本的 localhost WebDriver 端点，默认 127.0.0.1:4447，可被环境变量覆盖；与生产原生桥接分开评估，检查驱动监听与测试环境访问控制。

位置：[tools/verify-explorer-moves-desktop.mjs:31](../../../tools/verify-explorer-moves-desktop.mjs)。

## 5. 文件热点

| 文件 | 总数 | error | warning |
|---|---:|---:|---:|
| [src/components/Explorer.tsx](../../../src/components/Explorer.tsx) | 16 | 9 | 7 |
| [src/components/EditorGroup.tsx](../../../src/components/EditorGroup.tsx) | 13 | 5 | 8 |
| [src/components/QuickOpen.tsx](../../../src/components/QuickOpen.tsx) | 10 | 6 | 4 |
| [src/components/MediaPreview.tsx](../../../src/components/MediaPreview.tsx) | 7 | 2 | 5 |
| [src/editor/documents.ts](../../../src/editor/documents.ts) | 6 | 0 | 6 |
| [src/components/SearchView.tsx](../../../src/components/SearchView.tsx) | 5 | 1 | 4 |
| [src/hooks/useExternalDrop.ts](../../../src/hooks/useExternalDrop.ts) | 4 | 4 | 0 |
| [src/editor/languages.ts](../../../src/editor/languages.ts) | 3 | 0 | 3 |
| [src/components/App.tsx](../../../src/components/App.tsx) | 2 | 0 | 2 |
| [src/components/dialog.tsx](../../../src/components/dialog.tsx) | 2 | 0 | 2 |
| [src/hooks/useQuickFiles.ts](../../../src/hooks/useQuickFiles.ts) | 2 | 0 | 2 |
| [src/store/store.ts](../../../src/store/store.ts) | 2 | 0 | 2 |
| [src/components/EditorTabMenu.tsx](../../../src/components/EditorTabMenu.tsx) | 1 | 0 | 1 |
| [src/components/MarkdownPreview.tsx](../../../src/components/MarkdownPreview.tsx) | 1 | 0 | 1 |
| [src/core/commands.ts](../../../src/core/commands.ts) | 1 | 0 | 1 |
| [src/editor/editorLayout.test.ts](../../../src/editor/editorLayout.test.ts) | 1 | 0 | 1 |
| [src/editor/monaco.ts](../../../src/editor/monaco.ts) | 1 | 0 | 1 |
| [src/explorer/explorerClipboard.ts](../../../src/explorer/explorerClipboard.ts) | 1 | 0 | 1 |
| [src/explorer/externalDrop.ts](../../../src/explorer/externalDrop.ts) | 1 | 0 | 1 |
| [src/search/search.ts](../../../src/search/search.ts) | 1 | 0 | 1 |
| [src/utils/keybindings.ts](../../../src/utils/keybindings.ts) | 1 | 0 | 1 |
| [tools/notices.mjs](../../../tools/notices.mjs) | 1 | 1 | 0 |
| [tools/package-portable.mjs](../../../tools/package-portable.mjs) | 1 | 1 | 0 |
| [tools/verify-explorer-moves-desktop.mjs](../../../tools/verify-explorer-moves-desktop.mjs) | 1 | 0 | 1 |
| [tools/verify-quick-open.mjs](../../../tools/verify-quick-open.mjs) | 1 | 0 | 1 |

## 6. 扫描方法与边界

- 统计按诊断条目计数，未按根因去重；同一行或同一根因可触发多个规则。顶层 diagnostics 与 projects[0].diagnostics 是同一组结果，本报告只统计顶层一次。
- 原始严重级别来自 React Doctor；P1/P2/P3 是本报告人工分流建议。P1=优先修复或验证，P2=后续优化，P3=场景复核或低影响事项。未标注 P0 不代表通过安全审计。
- complete=true；92 个文件完成分析，skippedChecks=[]。范围包含前端源码、测试、tools 和 Vite 配置，不覆盖 Rust 后端的完整审计、桌面端原生权限或用户操作的端到端验证。
- 关闭遥测（--no-telemetry）也关闭官方评分 API，因此 score=null，未生成健康分数。未添加 --no-supply-chain；但 JSON 未单独给出供应链执行状态，不能据此宣称依赖安全已通过。
- 本次为静态扫描及代表性源码复核，没有运行构建、单元测试或应用交互性能测试。建议与已存在的验证记录分别解读。
- 现有 .oxlintrc.json 关闭 immutability、preserve-manual-memoization、refs、set-state-in-effect，并忽略 tools；React Doctor 仍报告这些项目，检查范围与规则体系不同，不与现有 lint 结果直接等同。
- 原始输出 ok=true 表示扫描成功；退出码 1 是默认 error 门禁触发。本次不是命令执行失败。stderr 中只有工具依赖的弃用提示。

- 代码版本：`d5472b5e34161d1ca5ba775ea7d22d70e5c77d81`；扫描前工作区干净。
- 工具报告扫描耗时：21.83 秒（不含首次下载和 npm 安装）。
- 环境：Windows、Node.js v24.14.0、npm 11.9.0；React 19.3.1、Vite 8.3.4、TypeScript 6.0.3。
- 报告日期使用会话提供的 Asia/Shanghai 日期；本机文件时间不作为报告日期依据。

复跑命令（项目根目录）：

```powershell
npx --yes react-doctor@0.9.18 . --yes --scope full --no-telemetry --json --json-out docs/verification/react-doctor-2026-10-21/raw-report.json
```

来源：[React Doctor CLI 官方文档](https://www.react.doctor/docs/reference/cli-reference) · [项目仓库](https://github.com/millionco/react-doctor)。实际参数以本次 0.9.18 的 --help 为准。

## 7. 完整诊断索引（85 条）

原始 message/help 可在 HTML 展开查看或在 JSON 搜索；以下保持原始次序与行列号。

| ID | 级别 | 优先级 | 分类 | 位置 | 规则 |
|---:|---|---|---|---|---|
| 1 | warning | P2 | 可维护性 | [src/components/App.tsx:103:16](../../../src/components/App.tsx) | react-doctor/no-high-complexity-react-function |
| 2 | warning | P2 | 可维护性 | [src/components/App.tsx:103:25](../../../src/components/App.tsx) | react-doctor/no-giant-component |
| 3 | warning | P2 | 可维护性 | [src/components/EditorGroup.tsx:41:8](../../../src/components/EditorGroup.tsx) | react-doctor/no-high-complexity-react-function |
| 4 | warning | P2 | 可维护性 | [src/components/EditorGroup.tsx:41:17](../../../src/components/EditorGroup.tsx) | react-doctor/no-giant-component |
| 5 | error | P1 | 性能与编译器 | [src/components/EditorGroup.tsx:195:13](../../../src/components/EditorGroup.tsx) | react-hooks-js/immutability |
| 6 | error | P1 | 性能与编译器 | [src/components/EditorGroup.tsx:205:7](../../../src/components/EditorGroup.tsx) | react-hooks-js/immutability |
| 7 | warning | P2 | 性能与编译器 | [src/components/EditorGroup.tsx:250:9](../../../src/components/EditorGroup.tsx) | react-doctor/async-await-in-loop |
| 8 | warning | P1 | 正确性与健壮性 | [src/components/EditorGroup.tsx:295:30](../../../src/components/EditorGroup.tsx) | react-doctor/no-unsafe-json-parse |
| 9 | warning | P2 | 性能与编译器 | [src/components/EditorGroup.tsx:315:30](../../../src/components/EditorGroup.tsx) | react-doctor/js-set-map-lookups |
| 10 | warning | P1 | 无障碍与交互 | [src/components/EditorGroup.tsx:377:20](../../../src/components/EditorGroup.tsx) | react-doctor/html-no-nested-interactive |
| 11 | warning | P2 | 正确性与健壮性 | [src/components/EditorGroup.tsx:447:25](../../../src/components/EditorGroup.tsx) | react-doctor/no-array-index-as-key |
| 12 | error | P1 | 性能与编译器 | [src/components/EditorGroup.tsx:581:5](../../../src/components/EditorGroup.tsx) | react-hooks-js/immutability |
| 13 | error | P1 | 性能与编译器 | [src/components/EditorGroup.tsx:588:22](../../../src/components/EditorGroup.tsx) | react-hooks-js/immutability |
| 14 | error | P1 | 性能与编译器 | [src/components/EditorGroup.tsx:601:22](../../../src/components/EditorGroup.tsx) | react-hooks-js/immutability |
| 15 | warning | P2 | 可维护性 | [src/components/EditorGroup.tsx:673:23](../../../src/components/EditorGroup.tsx) | react-doctor/only-export-components |
| 16 | warning | P2 | 正确性与健壮性 | [src/components/EditorTabMenu.tsx:111:34](../../../src/components/EditorTabMenu.tsx) | react-doctor/no-array-index-as-key |
| 17 | warning | P2 | 可维护性 | [src/components/Explorer.tsx:52:17](../../../src/components/Explorer.tsx) | react-doctor/only-export-components |
| 18 | warning | P2 | 可维护性 | [src/components/Explorer.tsx:57:17](../../../src/components/Explorer.tsx) | react-doctor/no-giant-component |
| 19 | warning | P2 | 性能与编译器 | [src/components/Explorer.tsx:85:33](../../../src/components/Explorer.tsx) | react-doctor/rerender-lazy-ref-init |
| 20 | error | P1 | 正确性与健壮性 | [src/components/Explorer.tsx:147:3](../../../src/components/Explorer.tsx) | react-doctor/no-ref-current-in-render |
| 21 | error | P1 | 性能与编译器 | [src/components/Explorer.tsx:147:3](../../../src/components/Explorer.tsx) | react-hooks-js/refs |
| 22 | error | P1 | 性能与编译器 | [src/components/Explorer.tsx:149:8](../../../src/components/Explorer.tsx) | react-hooks-js/refs |
| 23 | error | P1 | 性能与编译器 | [src/components/Explorer.tsx:150:52](../../../src/components/Explorer.tsx) | react-hooks-js/refs |
| 24 | error | P3 | 性能与编译器 | [src/components/Explorer.tsx:192:7](../../../src/components/Explorer.tsx) | react-hooks-js/todo |
| 25 | error | P3 | 性能与编译器 | [src/components/Explorer.tsx:282:13](../../../src/components/Explorer.tsx) | react-hooks-js/todo |
| 26 | error | P3 | 性能与编译器 | [src/components/Explorer.tsx:409:5](../../../src/components/Explorer.tsx) | react-hooks-js/todo |
| 27 | warning | P3 | 安全边界 | [src/components/Explorer.tsx:550:5](../../../src/components/Explorer.tsx) | react-doctor/postmessage-origin-risk |
| 28 | warning | P2 | 性能与编译器 | [src/components/Explorer.tsx:692:7](../../../src/components/Explorer.tsx) | react-hooks-js/set-state-in-effect |
| 29 | error | P3 | 性能与编译器 | [src/components/Explorer.tsx:741:46](../../../src/components/Explorer.tsx) | react-hooks-js/todo |
| 30 | error | P3 | 性能与编译器 | [src/components/Explorer.tsx:771:24](../../../src/components/Explorer.tsx) | react-hooks-js/todo |
| 31 | warning | P2 | 性能与编译器 | [src/components/Explorer.tsx:809:11](../../../src/components/Explorer.tsx) | react-doctor/async-await-in-loop |
| 32 | warning | P1 | 无障碍与交互 | [src/components/Explorer.tsx:848:6](../../../src/components/Explorer.tsx) | react-doctor/no-noninteractive-element-interactions |
| 33 | warning | P3 | 正确性与健壮性 | [src/components/MarkdownPreview.tsx:107:9](../../../src/components/MarkdownPreview.tsx) | react-doctor/no-prevent-default |
| 34 | warning | P2 | 可维护性 | [src/components/MediaPreview.tsx:10:8](../../../src/components/MediaPreview.tsx) | react-doctor/no-high-complexity-react-function |
| 35 | warning | P2 | 性能与编译器 | [src/components/MediaPreview.tsx:20:5](../../../src/components/MediaPreview.tsx) | react-hooks-js/set-state-in-effect |
| 36 | error | P1 | 正确性与健壮性 | [src/components/MediaPreview.tsx:170:3](../../../src/components/MediaPreview.tsx) | react-doctor/no-ref-current-in-render |
| 37 | error | P1 | 性能与编译器 | [src/components/MediaPreview.tsx:170:3](../../../src/components/MediaPreview.tsx) | react-hooks-js/refs |
| 38 | warning | P1 | 无障碍与交互 | [src/components/MediaPreview.tsx:211:6](../../../src/components/MediaPreview.tsx) | react-doctor/no-static-element-interactions |
| 39 | warning | P1 | 无障碍与交互 | [src/components/MediaPreview.tsx:247:10](../../../src/components/MediaPreview.tsx) | react-doctor/click-events-have-key-events |
| 40 | warning | P1 | 无障碍与交互 | [src/components/MediaPreview.tsx:247:10](../../../src/components/MediaPreview.tsx) | react-doctor/no-noninteractive-element-interactions |
| 41 | warning | P2 | 可维护性 | [src/components/QuickOpen.tsx:36:8](../../../src/components/QuickOpen.tsx) | react-doctor/no-high-complexity-react-function |
| 42 | warning | P2 | 可维护性 | [src/components/QuickOpen.tsx:36:17](../../../src/components/QuickOpen.tsx) | react-doctor/no-giant-component |
| 43 | error | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:95:21](../../../src/components/QuickOpen.tsx) | react-hooks-js/preserve-manual-memoization |
| 44 | error | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:109:13](../../../src/components/QuickOpen.tsx) | react-hooks-js/preserve-manual-memoization |
| 45 | error | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:109:26](../../../src/components/QuickOpen.tsx) | react-hooks-js/preserve-manual-memoization |
| 46 | warning | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:157:5](../../../src/components/QuickOpen.tsx) | react-hooks-js/set-state-in-effect |
| 47 | error | P1 | 性能与编译器 | [src/components/QuickOpen.tsx:225:11](../../../src/components/QuickOpen.tsx) | react-hooks-js/refs |
| 48 | error | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:367:5](../../../src/components/QuickOpen.tsx) | react-hooks-js/preserve-manual-memoization |
| 49 | error | P2 | 性能与编译器 | [src/components/QuickOpen.tsx:387:13](../../../src/components/QuickOpen.tsx) | react-hooks-js/preserve-manual-memoization |
| 50 | warning | P2 | 正确性与健壮性 | [src/components/QuickOpen.tsx:547:55](../../../src/components/QuickOpen.tsx) | react-doctor/no-array-index-as-key |
| 51 | warning | P2 | 可维护性 | [src/components/SearchView.tsx:22:8](../../../src/components/SearchView.tsx) | react-doctor/no-high-complexity-react-function |
| 52 | warning | P2 | 可维护性 | [src/components/SearchView.tsx:22:17](../../../src/components/SearchView.tsx) | react-doctor/no-giant-component |
| 53 | error | P3 | 性能与编译器 | [src/components/SearchView.tsx:152:20](../../../src/components/SearchView.tsx) | react-hooks-js/todo |
| 54 | warning | P2 | 正确性与健壮性 | [src/components/SearchView.tsx:367:12](../../../src/components/SearchView.tsx) | react-doctor/no-array-index-as-key |
| 55 | warning | P1 | 无障碍与交互 | [src/components/SearchView.tsx:427:13](../../../src/components/SearchView.tsx) | react-doctor/interactive-supports-focus |
| 56 | warning | P2 | 可维护性 | [src/components/dialog.tsx:16:17](../../../src/components/dialog.tsx) | react-doctor/only-export-components |
| 57 | warning | P2 | 可维护性 | [src/components/dialog.tsx:58:17](../../../src/components/dialog.tsx) | react-doctor/only-export-components |
| 58 | warning | P2 | 性能与编译器 | [src/core/commands.ts:243:54](../../../src/core/commands.ts) | react-doctor/js-set-map-lookups |
| 59 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:371:66](../../../src/editor/documents.ts) | react-doctor/js-set-map-lookups |
| 60 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:375:53](../../../src/editor/documents.ts) | react-doctor/js-set-map-lookups |
| 61 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:491:7](../../../src/editor/documents.ts) | react-doctor/async-await-in-loop |
| 62 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:633:7](../../../src/editor/documents.ts) | react-doctor/async-await-in-loop |
| 63 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:706:8](../../../src/editor/documents.ts) | react-doctor/js-set-map-lookups |
| 64 | warning | P2 | 性能与编译器 | [src/editor/documents.ts:931:20](../../../src/editor/documents.ts) | react-doctor/async-await-in-loop |
| 65 | warning | P3 | 性能与编译器 | [src/editor/editorLayout.test.ts:81:26](../../../src/editor/editorLayout.test.ts) | react-doctor/no-json-parse-stringify-clone |
| 66 | warning | P2 | 性能与编译器 | [src/editor/languages.ts:361:7](../../../src/editor/languages.ts) | react-doctor/async-await-in-loop |
| 67 | warning | P2 | 性能与编译器 | [src/editor/languages.ts:408:5](../../../src/editor/languages.ts) | react-doctor/async-await-in-loop |
| 68 | warning | P2 | 性能与编译器 | [src/editor/languages.ts:448:22](../../../src/editor/languages.ts) | react-doctor/async-await-in-loop |
| 69 | warning | P2 | 性能与编译器 | [src/editor/monaco.ts:1:1](../../../src/editor/monaco.ts) | react-doctor/prefer-dynamic-import |
| 70 | warning | P2 | 性能与编译器 | [src/explorer/explorerClipboard.ts:108:11](../../../src/explorer/explorerClipboard.ts) | react-doctor/async-await-in-loop |
| 71 | warning | P2 | 性能与编译器 | [src/explorer/externalDrop.ts:86:9](../../../src/explorer/externalDrop.ts) | react-doctor/async-await-in-loop |
| 72 | error | P1 | 正确性与健壮性 | [src/hooks/useExternalDrop.ts:21:3](../../../src/hooks/useExternalDrop.ts) | react-doctor/effect-needs-cleanup |
| 73 | error | P3 | 性能与编译器 | [src/hooks/useExternalDrop.ts:130:7](../../../src/hooks/useExternalDrop.ts) | react-hooks-js/todo |
| 74 | error | P3 | 性能与编译器 | [src/hooks/useExternalDrop.ts:134:11](../../../src/hooks/useExternalDrop.ts) | react-hooks-js/todo |
| 75 | error | P3 | 性能与编译器 | [src/hooks/useExternalDrop.ts:176:17](../../../src/hooks/useExternalDrop.ts) | react-hooks-js/todo |
| 76 | warning | P1 | 正确性与健壮性 | [src/hooks/useQuickFiles.ts:21:12](../../../src/hooks/useQuickFiles.ts) | react-doctor/no-unsafe-json-parse |
| 77 | warning | P2 | 性能与编译器 | [src/hooks/useQuickFiles.ts:57:7](../../../src/hooks/useQuickFiles.ts) | react-hooks-js/set-state-in-effect |
| 78 | warning | P2 | 性能与编译器 | [src/search/search.ts:338:12](../../../src/search/search.ts) | react-doctor/async-await-in-loop |
| 79 | warning | P2 | 性能与编译器 | [src/store/store.ts:97:18](../../../src/store/store.ts) | react-doctor/js-set-map-lookups |
| 80 | warning | P2 | 性能与编译器 | [src/store/store.ts:111:11](../../../src/store/store.ts) | react-doctor/js-set-map-lookups |
| 81 | warning | P2 | 性能与编译器 | [src/utils/keybindings.ts:11:61](../../../src/utils/keybindings.ts) | react-doctor/js-set-map-lookups |
| 82 | error | P3 | 安全边界 | [tools/notices.mjs:38:3](../../../tools/notices.mjs) | react-doctor/import-metadata-execution-risk |
| 83 | error | P3 | 安全边界 | [tools/package-portable.mjs:34:1](../../../tools/package-portable.mjs) | react-doctor/import-metadata-execution-risk |
| 84 | warning | P3 | 安全边界 | [tools/verify-explorer-moves-desktop.mjs:31:61](../../../tools/verify-explorer-moves-desktop.mjs) | react-doctor/local-rpc-native-bridge-risk |
| 85 | warning | P3 | 安全边界 | [tools/verify-quick-open.mjs:48:7](../../../tools/verify-quick-open.mjs) | react-doctor/postmessage-origin-risk |
