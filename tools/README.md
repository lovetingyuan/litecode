# Development tools

Run these scripts from the repository root. A script without an npm command may
still be a manual verification entry point.

| Files                                                           | Purpose                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-tools.mjs`, `web-language-server.mjs`, `languages/`      | Build and package language services and Prettier; used by Tauri development and builds.                                                               |
| `patch-trees-*.mjs`, `trees/`                                   | Apply the pinned Trees dependency patches during installation and Vite startup; includes inline editing tests and compatibility with earlier patches. |
| `release.mjs`, `release.test.mjs`, `setup-updater.mjs`          | Release version preparation, its unit tests, and updater key setup. See [release instructions](../docs/releases.md).                                  |
| `package-portable.mjs`                                          | Package the Windows portable app from the release build. ZIP creation uses Windows `tar.exe`.                                                         |
| `notices.mjs`                                                   | Generate dependency license notices and inventory from the npm and Cargo locks.                                                                       |
| `verify-*.mjs`                                                  | Manual browser and desktop regression checks. `npm run test:e2e` runs `verify-desktop.mjs`; specialized checks run separately.                        |
| `fixtures/`, `process-resources.ps1`                            | Native media fixtures and Windows process resource measurements.                                                                                      |
| `benchmark-explorer-model.mjs`                                  | Read-only explorer benchmark; set `LITECODE_BENCH_ROOT`. See [benchmark instructions](../docs/verification/EXPLORER_PERFORMANCE.md).                  |
| `capture-website.mjs`, `capture-inline-conflicts-reference.mjs` | Recreate [website captures](../docs/website.md) and the [VS Code conflict reference](../docs/inline-conflicts.md).                                    |
| `report-verification.mjs`                                       | Generate performance and UI environment reports from matching desktop release evidence and the release manifest.                                      |

Browser checks generally require `npm run dev`. Desktop checks additionally need
the appropriate built executable and Windows tools; check the script and feature
documentation for prerequisites. `verify-git-{blame,branches,diff}.mjs`
are imported helpers, not standalone checks.

Updated verification scripts write disposable fixtures and evidence under `tmp/verification/`.
Older scripts may still use `.verification/`; published historical evidence remains in
`docs/verification/`.

After `npm run build:tools`, run `node tools/verify-formatting.mjs` to check the bundled
Prettier CLI and project configuration precedence. `verify-formatter-trust.mjs` also
requires a Debug desktop build and exercises native formatter authorization.

## Test policy

Keep automated checks for data preservation, authorization, concurrency, resource
ownership and protocol handling. Routine interactions that are immediately visible
when using the app belong in manual acceptance, including tab order, splits,
navigation, preview switching and loading indicators. Do not test colors, fonts,
pixel sizes, menu order or fixed presentation defaults. Screenshots are diagnostic or measurement
evidence, not UI acceptance assertions. Keep opt-in performance benchmarks separate
from ordinary correctness checks.

Run `npm test -- --maxWorkers=2` and
`cargo test --manifest-path src-tauri/Cargo.toml --lib` for the automated suites.
The worker limit keeps the frontend run's process count bounded. Core desktop
verification remains available through `npm run test:e2e` and the specialized
native scripts, including creation, moves, clipboard paste, recovery and updates.
Browser checks retain real Worker scheduling, startup retry and website routing.
Removed mock-IPC presentation scripts are covered by the
remaining domain tests and native workflows; inspect appearance manually.
