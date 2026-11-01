import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

export default defineConfig([
  globalIgnores([
    ".agents/**",
    ".verification/**",
    "artifacts/**",
    "dist/**",
    "dist-ssr/**",
    "playwright-report/**",
    "src-tauri/**",
    "test-results/**",
    "tmp/**",
    "tools/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    extends: [sonarjs.configs.recommended],
    languageOptions: {
      parser: tsParser,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
