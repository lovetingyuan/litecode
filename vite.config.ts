import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import "./tools/patch-trees-scroll.mjs";
const host = process.env.TAURI_DEV_HOST;
let gitHash = "unknown";
try {
  gitHash = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Source archives may not include Git metadata.
}
// Dependency patches must be applied before Vite optimizes and caches the tree.
const treesPatchHash = createHash("sha256")
  .update(readFileSync(new URL("./tools/patch-trees-scroll.mjs", import.meta.url)))
  .digest("hex")
  .slice(0, 12);

// https://vite.dev/config/
export default defineConfig(() => ({
  define: { __GIT_HASH__: JSON.stringify(gitHash) },
  cacheDir: `node_modules/.vite/trees-${treesPatchHash}`,
  plugins: [
    {
      name: "one-monaco-for-grammars",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer?.replace(/\\/g, "/").includes("/monaco-languages/") &&
          source.endsWith("/editor/editor.api.js")
        ) {
          return this.resolve("@codingame/monaco-vscode-editor-api", undefined, { skipSelf: true });
        }
      },
    },
    react(),
    babel({ plugins: ["babel-plugin-react-compiler"] }),
    tailwindcss(),
  ],
  resolve: {
    alias: [{ find: /^monaco-editor(\/|$)/, replacement: "@codingame/monaco-vscode-editor-api$1" }],
    dedupe: [
      "react",
      "react-dom",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
    ],
  },
  optimizeDeps: {
    exclude: [
      "monaco-languageclient",
      "vscode",
      ...readdirSync(new URL("./node_modules/@codingame", import.meta.url)).map(
        (name) => `@codingame/${name}`,
      ),
    ],
    include: [
      "vscode-languageclient/browser",
      "vscode-jsonrpc/browser",
      "vscode-languageserver-protocol",
      "vscode-languageserver-protocol/browser",
    ],
  },
  build: { target: "esnext", chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.verification/**", "**/artifacts/**"],
    },
  },
}));
