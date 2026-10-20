import { cp, mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const binary = await readFile('src-tauri/target/release/litecode.exe');
const build = sha(binary).slice(0, 12);
const name = `LiteCode-${pkg.version}-${build}-win-x64`;
const directory = path.resolve('artifacts', name);
await mkdir(path.join(directory, 'data'), { recursive: true });
await writeFile(path.join(directory, 'data', '.portable'), 'An adjacent data directory enables portable mode. Keep this directory when upgrading.\n');
await writeFile(path.join(directory, 'LiteCode.exe'), binary);
await cp('src-tauri/tools', path.join(directory, 'tools'), { recursive: true });
await cp('docs', path.join(directory, 'docs'), { recursive: true, filter: source => !source.endsWith('PERFORMANCE.md') && !source.endsWith('release-manifest.json') });
await copyFile('README.md', path.join(directory, 'README.md'));
await copyFile('docs/verification/LIMITATIONS.md', path.join(directory, 'LIMITATIONS.md'));
const zip = path.resolve('artifacts', `${name}-portable.zip`);
try { await stat(zip); throw new Error(`Archive already exists: ${zip}`); } catch (error) { if (error.code !== 'ENOENT') {throw error;} }
execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('tools/package-portable.ps1'), '-SourceDirectory', directory, '-OutputPath', zip], { windowsHide: true });
const installerName = `LiteCode_${pkg.version}_x64-setup.exe`;
const installer = path.resolve('artifacts', installerName);
await copyFile(path.join('src-tauri/target/release/bundle/nsis', installerName), installer);
const artifacts = [];
for (const file of [zip, installer]) { const bytes = await readFile(file); artifacts.push({ name: path.basename(file), bytes: bytes.length, sha256: sha(bytes) }); }
const report = { version: pkg.version, build, generatedAt: new Date().toISOString(), platform: 'Windows x64', executableSha256: sha(binary), packageLockSha256: sha(await readFile('package-lock.json')), cargoLockSha256: sha(await readFile('src-tauri/Cargo.lock')), artifacts };
await writeFile('artifacts/manifest.json', JSON.stringify(report, null, 2));
await writeFile('docs/verification/release-manifest.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
