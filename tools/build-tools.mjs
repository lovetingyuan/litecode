import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('src-tauri/tools', { recursive: true });
await build({ entryPoints: ['tools/web-language-server.mjs'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', mainFields: ['module', 'main'], outfile: 'src-tauri/tools/web-language-server.cjs', minify: false, legalComments: 'eof' });
for (const name of ['package.json', 'package-lock.json']) await copyFile(`tools/languages/${name}`, `src-tauri/tools/languages-${name}`);
