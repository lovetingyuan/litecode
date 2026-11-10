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

1. Commit your development changes on `main`, then run `npm run release -- 0.2.0` with the desired stable version. The command synchronizes the version files, creates the release commit and tag, and pushes `main` and the tag together. It also accepts version files already prepared for the same release. If the push fails, resolve the Git error and run the same command again.
2. Open **Actions → Desktop release** and wait for all jobs, including **verify-draft**, to pass. The action creates a draft and attaches the installers, updater artifacts, signatures, and `latest.json`. The Windows job also attaches the portable ZIP. If a job fails, keep the release in draft and rerun the failed jobs after fixing runner or secret settings.
3. Edit the release notes in the draft and publish it as the latest official release. To show the same text in the app's update dialog, set the `notes` field in `latest.json` before publishing. For the first CI release, install the new package directly. To verify future updates, install from the previous CI release and use **Help → Check for Updates…**.

The updater reads `https://github.com/lovetingyuan/litecode/releases/latest/download/latest.json`. Keep the completed manifest and its referenced assets together. Drafts and prereleases are outside the stable update channel.

## Application updates

Use **Help → Check for Updates…** or the command palette. Each application launch checks silently, with all editor windows sharing one process-wide schedule. While the app remains open, it checks once per local calendar day and retries failed checks every 30 minutes until one succeeds. The schedule is evaluated every 60 seconds, so a check missed across midnight or while the computer sleeps runs within 60 seconds of normal execution resuming. It does not wake the computer or replay checks for previous days. Automatic checks wait while an update is downloading or installing; manual checks bypass the daily and retry limits. An available update adds a button at the upper right without opening a dialog.

Installed editions download and verify the update, checkpoint all editor windows, then install the update and reopen. Terminal tasks stop during installation. Unsaved text is restored from recovery records rather than written over the original files.

A window that cannot checkpoint, closes during preparation, or fails to respond within 30 seconds prevents installation. Download or signature errors leave the current version running and allow retry. Portable editions display the release and link to its downloads; replace the portable program/resources manually while keeping the adjacent `data` directory.

Versions distributed before this update feature must be upgraded manually once.

## Verification

`npm test` includes tests for the release command against a local Git remote, update state, and recovery acknowledgements.

Run `npm run build` first, then `node tools/verify-updates-desktop.mjs`. This builds two signed debug NSIS installers with a unique test application identifier, temporary signing key, isolated Cargo target directory, and isolated installation directory. It verifies update checks, shared operations, signature rejection, a real locked-backup failure, the 30-second backup timeout, installation, restart, and unsaved-buffer recovery. It uninstalls the fixture afterwards and keeps evidence under `.verification/updates-*/`. The production build cannot use the loopback endpoint override used by this test.
