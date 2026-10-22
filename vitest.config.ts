import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";
import { fileURLToPath } from "node:url";

export default defineConfig(async (env) =>
  mergeConfig(await (typeof viteConfig === "function" ? viteConfig(env) : viteConfig), {
    test: { exclude: [...configDefaults.exclude, ".verification/**", "artifacts/**"] },
    resolve: {
      alias: [{
        find: /^vscode-jsonrpc\/browser$/,
        replacement: fileURLToPath(new URL("./node_modules/vscode-jsonrpc/lib/browser/main.js", import.meta.url)),
      }],
    },
  }),
);
