# ![LiteCode logo](src-tauri/icons/32x32.png) LiteCode

A lightweight, open-source VS Code alternative for Windows, built with Tauri.

**Website:** [litecode.tingyuan.in](https://litecode.tingyuan.in/en/) · **Download:** [GitHub Releases](https://github.com/lovetingyuan/litecode/releases)

![LiteCode feature demo](docs/images/demo.gif)

[Watch the feature demo (MP4)](docs/images/demo.mp4)

## Why LiteCode

In the age of AI coding, a lightweight editor still has a place. LiteCode keeps the familiar feel of VS Code and the essentials close at hand, so you can open a local project, understand generated code, review changes, and refine the details yourself.

## Main features

- File and folder management, quick open, and full-text search and replace.
- Tabbed editing, split views, a command palette, and custom keyboard shortcuts.
- Syntax highlighting, code completion, navigation, diagnostics, and formatting.
- Integrated terminals with multiple tabs and split panes.
- Git source control, diff views, staging, and commits.
- Live Markdown preview, plus image, audio, and video previews.

The Windows installer adds **Open with LiteCode** to the File Explorer menus for files, folders, and folder backgrounds. Each action opens a separate window. On Windows 11, select **Show more options** to find it. Uninstalling removes the menu; portable builds do not register it.

## Tech stack

Built with Tauri 2 and Rust, React and TypeScript, Monaco Editor, and xterm.js.

## Development commands

Run `npm ci` first. Desktop development requires Node.js 24+, Rust, and the Windows build tools.

| Command                  | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `npm run tauri -- dev`   | Start the desktop app and Vite dev server.                                     |
| `npm run tauri -- build` | Build the desktop installer.                                                   |
| `npm run dev`            | Start only the frontend dev server.                                            |
| `npm run build`          | Type-check and build the frontend.                                             |
| `npm run lint`           | Lint; add `-- --fix` to apply fixes.                                           |
| `npm run format`         | Format files with Oxfmt, excluding generated language tools.                   |
| `npm test`               | Run unit tests.                                                                |
| `npm run test:e2e`       | Run desktop verification with the debug app built and Vite running.            |
| `npm run release`        | Run the signed release workflow; see [release instructions](docs/releases.md). |

`build:tools` packages the Web, TypeScript, and Vue language services and Prettier, including its configuration loaders and language plugins. Tauri runs it automatically before development and builds; run `npm run build:tools` manually when rebuilding tools for a direct Cargo build. `postinstall` applies the required Trees scroll patch automatically after installing dependencies.

Supported non-Rust files, including HTML, Markdown and JSONC, use the nearest project Prettier or bundled Prettier for document formatting and `editor.formatOnSave`. Node.js is required, but Prettier and Language Tools do not need to be installed separately. Prettier configuration overrides `.editorconfig`; unspecified options use Prettier defaults. Project plugins must be installed by the project. Invalid configurations or missing plugins report an error without replacing the buffer. Rust continues to use rustfmt. The repository's `npm run format` still uses Oxfmt.

Debug builds use the `dev` subdirectory of the normal application data directory, so the development app and installed release can run together with separate settings and recovery sessions. Each data directory retains its own single-instance protection. An existing `data` directory beside the executable still takes precedence for portable mode.

The Windows installer adds **Open with LiteCode** to the classic context menus for files, folders, and folder backgrounds (under **Show more options** on Windows 11). Each invocation opens one window for the selected file or folder, leaving existing windows intact. Starting this way defers historical window recovery until the next normal launch; recovery data is preserved. Install the updated installer to refresh existing context-menu registrations.

Run `node tools/verify-shell-open.mjs` with the debug app built and Vite running to verify shell-open window counts and deferred recovery. An optional executable path tests a bundled build instead. Fixtures and results are isolated under `tmp/`.

## Error logs

Use **Help → Open Logs Folder**, or run **Open Logs Folder** from the command palette, to open the current profile's `logs` directory. Errors are saved locally as JSON Lines in `litecode.log`. Each file rotates at 2 MiB, retaining four archives (approximately 10 MiB total). Installed Windows builds use `%APPDATA%/com.tingyuan.litecode/logs`; development builds add `dev` before `logs`, and portable builds use `data/logs` beside the executable.

Logs cover critical frontend and native failures, including startup, files, backups and recovery, search and replacement, Git, terminals, language services, previews, and updates. Records include timestamps, version, process and operation identifiers, window, error category, and available details or stack traces. Repeated failures are limited to one record per category/message every 30 seconds; the next occurrence includes a suppressed count. Cancellation, trust prompts, normal shutdown, and editor diagnostics are excluded.

Logs can contain local paths. URL credentials and named tokens are redacted; document contents, search/replacement text, terminal input/output, commit messages, environment values, and complete IPC arguments are not collected. Parser and external tool output are omitted where they could contain source text. Records are capped at 16 KiB. Logs are never uploaded automatically. If file logging cannot initialize, the application continues with stderr logging and a startup warning. Errors before initialization use stderr; forced process termination cannot always be recorded. Startup performance profiling through `LITECODE_STARTUP_LOG` remains separate.

Specialized checks run directly: `node tools/verify-languages.mjs` after packaging language tools, `node tools/verify-vue.mjs` with the debug app built and Vite running, and `node tools/verify-updates-desktop.mjs` after `npm run build`. See [language verification](docs/verification/LANGUAGE_CAPABILITIES.md) and [update verification](docs/releases.md#verification).
