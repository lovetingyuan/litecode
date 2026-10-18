import { readFile, writeFile } from 'node:fs/promises';
const run = JSON.parse(await readFile('docs/verification/desktop-results.json', 'utf8'));
const manifest = JSON.parse(await readFile('docs/verification/release-manifest.json', 'utf8'));
if (!run.release || run.executableSha256 !== manifest.executableSha256) throw new Error('Desktop evidence does not match the packaged Release executable.');
const machine = JSON.parse((await readFile('docs/verification/machine.json', 'utf8')).replace(/^\uFEFF/, ''));
const mib = bytes => (bytes / 1024 / 1024).toFixed(1);
const lines = [
  '# Observed Release measurements', '',
  `Build: ${manifest.build}; executable SHA-256: ${manifest.executableSha256}.`, '',
  `${machine.os.Caption} ${machine.os.Version}; ${machine.cpu[0].Name}; ${(machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB RAM; WebView2 ${run.capabilities.browserVersion}; devicePixelRatio ${run.environment.devicePixelRatio}.`, '',
  'A single isolated fixture run with a local TypeScript project, explicit tool paths and warmed OS/dependency caches. WebDriver automation is enabled. These are observations, not performance guarantees or complete planned workload acceptance.', '',
  '| Measurement | Observed |', '| --- | --- |',
  `| WebDriver session creation to Trees mounted | ${run.startupMs} ms |`,
  `| Search input to final 2-hit result (includes 250 ms debounce and WebDriver polling) | ${run.latencies.searchInputToFinalResultsMs.toFixed(1)} ms |`,
  `| WebDriver send-keys call for 7 ASCII characters (not frame/input latency) | ${run.latencies.webdriverSendKeysMs.toFixed(1)} ms |`,
  ...run.measurements.flatMap(sample => [
    `| ${sample.windows} window(s), process-group working set | ${mib(sample.workingSetBytes)} MiB |`,
    `| ${sample.windows} window(s), process-group private bytes | ${mib(sample.privateBytes)} MiB |`,
  ]),
  ...manifest.artifacts.map(file => `| ${file.name} | ${mib(file.bytes)} MiB |`), '',
  'Process groups include the Rust host, WebView2 browser/render/GPU/utility processes, language-server processes and console-host descendants present at capture time. Working-set sums can count shared pages more than once. Per-process memory and cumulative CPU seconds are retained in desktop-release-results.json. The one-window sample already has JSON and TypeScript services running; additional windows use small text fixtures.', '',
  'The full application group uses substantially more memory than the Rust host alone. The initial implementation still needs profiling and tuning; no claim that it is lighter than VS Code is made. Native input latency, cold/large-tree workloads, sustained CPU, disk usage after tool installation and a fixed-reference comparison are outstanding.', '',
  'Eight real Release screenshots and their logical/outer sizes/DPR are in the desktop report. They have not passed paired VS Code 1.142.0 visual acceptance.', '',
];
await writeFile('docs/verification/PERFORMANCE.md', lines.join('\n'));
await writeFile('docs/verification/ui/environment.json', JSON.stringify({ build: manifest.build, executableSha256: manifest.executableSha256, machine, browserVersion: run.capabilities.browserVersion, captures: run.screenshotEnvironments, referenceVerified: false }, null, 2));
console.log('Release measurements and capture environment recorded.');
