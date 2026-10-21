# Observed Release measurements

Build: 202314481181; executable SHA-256: 202314481181078f3412d2ed8920c238f38125047313cbb42e2dfa92e81e652d.

Microsoft Windows 11 专业版 10.0.22631; AMD Ryzen 7 8845H w/ Radeon 780M Graphics; 27.8 GiB RAM; WebView2 155.0.4283.60; devicePixelRatio 2.2200000286102295.

A single isolated fixture run with a local TypeScript project, explicit tool paths and warmed OS/dependency caches. WebDriver automation is enabled. These are observations, not performance guarantees or complete planned workload acceptance.

| Measurement                                                                         | Observed   |
| ----------------------------------------------------------------------------------- | ---------- |
| WebDriver session creation to Trees mounted                                         | 1146 ms    |
| Search input to final 2-hit result (includes 250 ms debounce and WebDriver polling) | 498.9 ms   |
| WebDriver send-keys call for 7 ASCII characters (not frame/input latency)           | 66.1 ms    |
| 1 window(s), process-group working set                                              | 1058.9 MiB |
| 1 window(s), process-group private bytes                                            | 1126.2 MiB |
| 3 window(s), process-group working set                                              | 1361.6 MiB |
| 3 window(s), process-group private bytes                                            | 1550.7 MiB |
| LiteCode-0.1.0-202314481181-win-x64-portable.zip                                    | 12.7 MiB   |
| LiteCode_0.1.0_x64-setup.exe                                                        | 9.1 MiB    |

Process groups include the Rust host, WebView2 browser/render/GPU/utility processes, language-server processes and console-host descendants present at capture time. Working-set sums can count shared pages more than once. Per-process memory and cumulative CPU seconds are retained in desktop-release-results.json. The one-window sample already has JSON and TypeScript services running; additional windows use small text fixtures.

The full application group uses substantially more memory than the Rust host alone. The initial implementation still needs profiling and tuning; no claim that it is lighter than VS Code is made. Native input latency, cold/large-tree workloads, sustained CPU, disk usage after tool installation and a fixed-reference comparison are outstanding.

Eight real Release screenshots and their logical/outer sizes/DPR are in the desktop report. They have not passed paired VS Code 1.142.0 visual acceptance.
