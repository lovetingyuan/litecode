import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;
let gitHash = "unknown";
try {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the developer's Git from PATH to support all existing build environments.
  gitHash = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Source archives may not include Git metadata.
}
// Invalidate Vite's optimized Trees modules when the installed patch changes.
const treesPatchHash = createHash("sha256")
  .update(readFileSync(new URL("./patches/@pierre+trees+1.0.0.patch", import.meta.url)))
  .digest("hex")
  .slice(0, 12);

const pdfjsAssetDirs = ["cmaps", "standard_fonts", "iccs", "wasm"] as const;
const pdfjsRoot = fileURLToPath(new URL("./node_modules/pdfjs-dist", import.meta.url));

function includePdfAsset(dir: (typeof pdfjsAssetDirs)[number], name: string): boolean {
  if (dir !== "wasm") {
    return true;
  }
  // Skip PDF JavaScript sandbox and non-WASM fallbacks; LiteCode never executes PDF JS.
  return !name.startsWith("quickjs-eval") && !name.endsWith("_nowasm_fallback.js");
}

function pdfAssetMimeType(file: string): string {
  if (file.endsWith(".wasm")) {
    return "application/wasm";
  }
  if (file.endsWith(".js") || file.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function pdfjsAssetsPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "pdfjs-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const clean = (req.url ?? "").split("?")[0].replace(/^\/+/, "");
        const [dir, ...rest] = clean.split("/");
        if (
          !dir ||
          !rest.length ||
          !pdfjsAssetDirs.includes(dir as (typeof pdfjsAssetDirs)[number]) ||
          rest.some(
            (segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"),
          )
        ) {
          next();
          return;
        }
        const candidate = path.resolve(pdfjsRoot, dir, ...rest);
        const expectedRoot = path.resolve(pdfjsRoot, dir) + path.sep;
        if (
          !candidate.startsWith(expectedRoot) ||
          !existsSync(candidate) ||
          !statSync(candidate).isFile()
        ) {
          next();
          return;
        }
        res.setHeader("Content-Type", pdfAssetMimeType(candidate));
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.end(readFileSync(candidate));
      });
    },
    writeBundle() {
      const targetRoot = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        outDir,
        "pdfjs",
      );
      for (const dir of pdfjsAssetDirs) {
        const sourceDir = path.join(pdfjsRoot, dir);
        if (!existsSync(sourceDir)) {
          continue;
        }
        const destDir = path.join(targetRoot, dir);
        mkdirSync(destDir, { recursive: true });
        for (const entry of readdirSync(sourceDir)) {
          if (includePdfAsset(dir, entry)) {
            cpSync(path.join(sourceDir, entry), path.join(destDir, entry), { recursive: true });
          }
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    __GIT_HASH__: JSON.stringify(gitHash),
    __APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version,
    ),
  },
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
    pdfjsAssetsPlugin(),
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
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: [
        "**/src-tauri/**",
        "**/.verification/**",
        "**/artifacts/**",
        // Windows watcher handles can interfere with renames in desktop verification fixtures.
        `${normalizePath(import.meta.dirname)}/tmp/**`,
      ],
    },
  },
}));
