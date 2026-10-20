import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('src-tauri/tools', { recursive: true });
await build({ entryPoints: ['tools/web-language-server.mjs'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', mainFields: ['module', 'main'], outfile: 'src-tauri/tools/web-language-server.cjs', minify: false, legalComments: 'eof' });
for (const name of ['package.json', 'package-lock.json']) {await copyFile(`tools/languages/${name}`, `src-tauri/tools/languages-${name}`);}

// Preserve sibling node_modules packages so the server can resolve its fallback
// TypeScript while preferring the workspace version. No Node.js runtime is shipped.
// https://github.com/typescript-language-server/typescript-language-server/blob/v6.0.2/src/tsServer/versionProvider.ts
for (const name of ['typescript-language-server', 'typescript']) {
  await cp(`node_modules/${name}`, `src-tauri/tools/typescript/node_modules/${name}`, { recursive: true });
}
