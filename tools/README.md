# Development tools

Run these scripts from the repository root. A script without an npm command may
still be a manual verification entry point.

| Files                                                           | Purpose                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-tools.mjs`, `web-language-server.mjs`, `languages/`      | Build and package language services; used by Tauri development and builds.                                                                            |
| `patch-trees-*.mjs`, `trees/`                                   | Apply the pinned Trees dependency patches during installation and Vite startup; includes inline editing tests and compatibility with earlier patches. |
| `release.mjs`, `release.test.mjs`, `setup-updater.mjs`          | Signed release workflow, its unit tests, and updater key setup. See [release instructions](../docs/releases.md).                                      |
| `package-portable.mjs`                                          | Package the portable app and installer; imported by the release workflow. ZIP creation uses Windows `tar.exe`.                                        |
| `notices.mjs`                                                   | Generate dependency license notices and inventory from the npm and Cargo locks.                                                                       |
| `verify-*.mjs`                                                  | Manual browser and desktop regression checks. `npm run test:e2e` runs `verify-desktop.mjs`; specialized checks run separately.                        |
| `explorer-fixture.mjs`, `fixtures/`, `process-resources.ps1`    | Shared verification fixtures and Windows process resource measurements.                                                                               |
| `benchmark-explorer-model.mjs`                                  | Read-only explorer benchmark; set `LITECODE_BENCH_ROOT`. See [benchmark instructions](../docs/verification/EXPLORER_PERFORMANCE.md).                  |
| `capture-website.mjs`, `capture-inline-conflicts-reference.mjs` | Recreate [website captures](../docs/website.md) and the [VS Code conflict reference](../docs/inline-conflicts.md).                                    |
| `report-verification.mjs`                                       | Generate performance and UI environment reports from matching desktop release evidence and the release manifest.                                      |

Browser checks generally require `npm run dev`. Desktop checks additionally need
the appropriate built executable and Windows tools; check the script and feature
documentation for prerequisites. `verify-git-{blame,branches,diff}.mjs` and
`verify-explorer-offscreen-creation.mjs` are imported helpers, not standalone checks.

Verification evidence is kept in `.verification/` or `docs/verification/`.
