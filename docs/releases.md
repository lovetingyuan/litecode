# Desktop releases

The [Desktop release workflow](../.github/workflows/release.yml) uses the official [Tauri GitHub Action](https://github.com/tauri-apps/tauri-action). A stable version tag builds these packages into one GitHub Release draft.

| Platform                      | Downloads                       |
| ----------------------------- | ------------------------------- |
| Windows x64                   | NSIS installer and portable ZIP |
| macOS Apple Silicon and Intel | A DMG per architecture          |
| Linux x64                     | AppImage and Debian package     |

## One-time setup

In the repository's **Settings → Secrets and variables → Actions**, add `TAURI_SIGNING_PRIVATE_KEY` with the contents of the private key matching the public key in `src-tauri/tauri.conf.json`. On the development machine the key is typically at `%USERPROFILE%\.tauri\litecode\updater.key`. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has a password. Back up the key securely so future releases can use it.

macOS packages use ad-hoc signing. For local acceptance, follow the macOS **Privacy & Security** prompt to open the downloaded app. Use Developer ID signing and Apple notarization when distributing to a wider audience.

## Test the build

In **Actions → Desktop release → Run workflow**, select a branch that includes the workflow. The four jobs produce downloadable workflow artifacts without updater signatures. Use those artifacts to verify fresh installation, startup, opening a workspace, and searching files on each platform.

## Publish a version

1. Start on `main` with a clean working tree and push any local commits to `origin/main`. Run `npm run release` without arguments. Enter the new stable version, then type Markdown release notes over multiple lines. Blank lines are allowed; enter `.` on its own line to finish. Empty notes are rejected, and ending input before `.` cancels the release. Outer whitespace is trimmed, matching Tauri Action's input handling.
2. The command fetches `origin/main` and checks that both branches point to the same commit. It updates the version files if needed, saves the notes in an annotated tag headed `LiteCode vX.Y.Z`, and pushes `main` and the tag together. If the push fails, resolve the Git error and synchronize `main` before running `npm run release` again. Enter the same version to reuse the existing tag and its notes. To sync a release commit left ahead after a failed push, run `git push --no-follow-tags origin main`.
3. Open **Actions → Desktop release** and wait for all jobs, including **verify-draft**, to pass. Actions reads the notes from the tag and uses them for both the Release body and `latest.json.notes`. The action attaches installers, updater artifacts, and signatures; the Windows job also attaches the portable ZIP. After every platform has finished, the workflow replaces asset API URLs in `latest.json` with public download URLs and verifies the completed manifest. If a job fails, keep the release in draft and rerun the failed jobs after fixing runner or secret settings.
4. Publish the verified draft as the latest official release. The tag is the source of truth for release notes; editing the Release body later does not automatically update the app's notes. Install the previous version and use **Help → Check for Updates…** to verify the upgrade.

The updater reads `https://github.com/lovetingyuan/litecode/releases/latest/download/latest.json`. Keep the completed manifest and its referenced assets together. Drafts and prereleases are outside the stable update channel.

The build workflow uses its authenticated repository token for GitHub API requests. Clients only request the public `latest.json` and the public installer download URL, avoiding anonymous API rate limits. Manifest finalization only runs against release drafts and requires the tag notes file; published releases are not modified. Original and finalized manifests are written under `tmp/release/vX.Y.Z/`.

## Roll back a failed release

To abandon a failed, unpublished `v0.2.2` release and restore version `0.2.0`, run `npm run release:rollback -- v0.2.2 0.2.0` from a clean `main`. The command commits the version change, pushes `main` and removes the failed tag from `origin` in one operation, then removes the local tag. Code changes stay in `main`. If the push fails, resolve the Git error and retry the same command.

If the workflow created a GitHub Release draft, remove that draft in GitHub before reusing the version.

## Application updates

Use **Help → Check for Updates…** or the command palette. Each application launch checks silently, with all editor windows sharing one process-wide schedule. While the app remains open, it checks once per local calendar day and retries failed checks every 30 minutes until one succeeds. The schedule is evaluated every 60 seconds, so a check missed across midnight or while the computer sleeps runs within 60 seconds of normal execution resuming. It does not wake the computer or replay checks for previous days. Automatic checks wait while an update is downloading or installing; manual checks bypass the daily and retry limits. An available update adds a button at the upper right without opening a dialog.

Installed editions download and verify the update, checkpoint all editor windows, then install the update and reopen. Terminal tasks stop during installation. Unsaved text is restored from recovery records rather than written over the original files.

A window that cannot checkpoint, closes during preparation, or fails to respond within 30 seconds prevents installation. Download or signature errors leave the current version running and allow retry. Portable editions display the release and link to its downloads; replace the portable program/resources manually while keeping the adjacent `data` directory.

Versions distributed before this update feature must be upgraded manually once.

## Verification

`npm test` includes tests for interactive release input and tag notes against a local Git remote, updater manifest finalization, update state, and recovery acknowledgements. To run only the release tooling tests, use `npx vitest run tools/release.test.mjs tools/finalize-updater.test.mjs`.

Run `npm run build` first, then `node tools/verify-updates-desktop.mjs`. This builds two signed debug NSIS installers with a unique test application identifier, temporary signing key, isolated Cargo target directory, and isolated installation directory. It verifies update checks, shared operations, signature rejection, a real locked-backup failure, the 30-second backup timeout, installation, restart, and unsaved-buffer recovery. It uninstalls the fixture afterwards and keeps evidence under `.verification/updates-*/`. The production build cannot use the loopback endpoint override used by this test.
