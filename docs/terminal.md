# 集成终端

点击活动栏 Search 下方的 Terminal，或按 `Ctrl+反引号`，切换到终端。编辑器和终端切换时都保留状态，后台任务继续运行。

顶部 `+` 创建独立 tab，下拉菜单选择已安装的 PowerShell 7、Windows PowerShell、cmd 或 Git Bash。默认优先使用 PowerShell 7；没有打开项目时，从用户主目录启动，否则从项目根目录启动。

使用顶部的左右／上下分屏按钮拆分当前分区。新分区继承源分区的 Shell profile 和当前目录，包括 `cd` 后的目录。拖动分隔条调整尺寸，悬停到分区右上角即可关闭。tab 支持拖动排序、双击重命名和右键菜单。

| 快捷键 | 操作 |
|---|---|
| `Ctrl+反引号` | 切换终端与编辑器 |
| `Ctrl+Shift+反引号` | 新建 tab |
| `Ctrl+Shift+5` | 向右分屏 |
| `Ctrl+PageUp / PageDown` | 上一个／下一个 tab |
| `Alt+方向键` | 切换分区 |
| `Ctrl+Shift+W` | 关闭当前分区 |
| `Ctrl+Shift+C / V` | 复制选区／粘贴 |
| `Ctrl+C` | 有选区时复制，否则发送中断 |
| `Ctrl+F` | 查找终端输出 |
| `Ctrl+= / - / 0` | 放大／缩小／重置字号 |

默认右键有选区时复制，否则粘贴；`Shift+右键` 打开终端菜单。`Ctrl+单击` 打开链接或本地文件位置。

## 设置

终端工具栏的齿轮打开现有 JSONC 设置。`terminal.integrated.*` 设置带有说明与补全，也可以在 `.litecode/settings.json` 中覆盖。例如：

```jsonc
{
  "terminal.integrated.fontFamily": "Cascadia Mono, Consolas, monospace",
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.lineHeight": 1.1,
  "terminal.integrated.cursorStyle": "bar",
  "terminal.integrated.scrollback": 5000,
  "terminal.integrated.defaultProfile.windows": "PowerShell",
  "terminal.integrated.profiles.windows": {
    "Clean PowerShell": {
      "source": "PowerShell",
      "args": ["-NoProfile"]
    },
    "Git Bash": null
  },
  "terminal.integrated.env.windows": {
    "DEMO_PROJECT": "${workspaceFolder}"
  }
}
```

字体、光标、回滚与交互设置即时生效；启动目录、环境变量和 profile 只影响新会话。`fontFamily` 为空时继承编辑器字体。profile 支持 `path` 或 `source`、`args`、`env`；设为 `null` 隐藏对应项。目录和环境变量支持 `${workspaceFolder}`、`${userHome}`、`${env:NAME}`。

Shell 集成默认启用，只在新 Shell 进程中安装目录上报钩子，不修改用户 profile 文件。禁用集成或自定义启动命令覆盖集成后，分屏使用最后已知目录并显示提示。

关闭分区会直接结束对应 Shell 及子进程；关闭窗口、重载页面、撤销工作区信任或切换项目也会清理对应会话。正常退出移除分区；异常退出保留输出和退出码，可在原分区重新启动。终端会话、输出和布局不跨应用重启恢复。

## 验证

运行 `npm run dev`，另行完成 `cargo build --manifest-path src-tauri/Cargo.toml` 后，可执行：

```sh
node tools/verify-terminal-desktop.mjs
```

该脚本创建独立的便携测试目录，使用真实 Tauri/WebView2、PTY 和本机 Shell，验证导航、分屏、目录继承、设置、组合输入、退出清理、窗口隔离，以及 8 会话／4 可见分区持续输出 60 秒。结果、进程内存采样和截图保存在 `.verification/terminal-*`。命令往返时间包含自动输入整条命令、Shell 执行和检测输出的开销，不能视为单次按键延迟。
