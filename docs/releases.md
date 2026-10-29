# Local Windows releases

Release from Windows x64 with Node.js 24+, Rust, the Windows build tools, Git, and `npm ci` installed. No GitHub Actions or GitHub CLI is required.

## One-time update signing setup

Run `node tools/setup-updater.mjs`. It creates an updater signing key in `%USERPROFILE%\.tauri\litecode\updater.key`, outside this repository, and writes only its public key into the Tauri configuration. Commit that configuration along with the update feature before releasing. The setup command never replaces an existing key.

Back up `updater.key` and `updater.key.pub` securely. All future releases must use the same private key so existing installations can verify them. The default local key is protected by the user's filesystem account and has no additional password. For an encrypted or separately stored key, set `TAURI_SIGNING_PRIVATE_KEY` to its path or contents and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password in the release terminal. Never commit these values.

The initial key has been generated on the development machine. Other machines need a secure copy of the same key, rather than a newly generated key.

## Publish a version

1. Commit your changes and push `main`. The script requires a clean tree, including untracked files, with local `main` exactly matching `origin/main`.
2. Run `npm run release` from an interactive terminal. Enter a higher stable version such as `0.2.0` (or accept the suggested patch version).
3. Enter release notes on one line, with two consecutive spaces between items: `Fix opening files  Add automatic updates`. Each item becomes a Markdown bullet. A single space stays inside an item. Ctrl+C cancels input.
4. The script checks the signing key, synchronizes all application versions, and creates a local `chore(release): vX.Y.Z` commit. It runs lint, frontend tests, Rust tests, and the signed release build. Committing first ensures the executable's About commit matches its release tag.
5. The script collects and verifies artifacts in `artifacts/releases/vX.Y.Z/`, creates an annotated tag, and atomically pushes only `main` and that tag. It never force-pushes.
6. Your browser opens GitHub's new Release form with the tag, title, and release notes filled in. The artifact directory opens as well. Upload the installer `.exe`, installer `.exe.sig`, portable `.zip`, `latest.json`, `SHA256SUMS.txt`, `manifest.json`, and optionally `RELEASE_NOTES.md`. The unpacked portable directory and `release-url.txt` are local conveniences and need not be uploaded.
7. Keep the Release as a draft until all attachments have finished uploading, then publish it as the latest **official** release. Do not mark it as a prerelease. Do not change the version/tag or remove required assets. If editing the release notes, update `latest.json`'s `notes` field to match before uploading.

`latest.json` contains the version, notes, and signed Windows x64 installer URL under the exact version tag. The client checks `https://github.com/lovetingyuan/litecode/releases/latest/download/latest.json`. Drafts and prereleases are not the normal update channel. A published Release missing its manifest is reported as a check failure, not as "up to date".

## Failures and recovery

- No tag or push occurs until tests, build, artifact collection, and signature verification succeed. Existing output directories and tags are never overwritten.
- A failed build leaves the local version commit and any diagnostic artifacts in place. Inspect the failure; do not blindly rerun the interactive release command, which requires synchronized `main`. Fix and commit the problem, push the resulting source commits, and release a new version. An unused local version is harmless.
- A rejected or interrupted push retains the local commit, annotated tag, and artifacts. The script checks whether GitHub actually accepted both refs and otherwise prints the precise retry command. Resolve access or branch protection problems, check the remote refs, and retry that command; no rebuild is needed if the release commit and artifacts have not changed.
- If a build modifies tracked generated resources, publishing stops. Review and commit the resource changes before preparing a new release. The release path deliberately does not overwrite historical verification reports.
- If browser opening fails, use the printed URL or `release-url.txt`. The full notes remain in `RELEASE_NOTES.md`.
- If a process is forcibly terminated, a lock can remain at `artifacts/.release.lock`. Confirm the recorded process is no longer releasing before removing that file. Partial artifact directories are preserved for inspection; move them aside if intentionally retrying an unpublished version.

## Application updates

Use **Help → Check for Updates…** or the command palette. Startup checks run once per process without opening a dialog; an available update adds a button at the upper right. Installed editions download and verify the update, checkpoint all editor windows, then run the NSIS updater and reopen. Terminal tasks stop during installation. Unsaved text is restored from recovery records rather than written over the original files.

A window that cannot checkpoint, closes during preparation, or fails to respond within 30 seconds prevents installation. Download or signature errors leave the current version running and allow retry. Portable editions display the release and link to its downloads; replace the portable program/resources manually while keeping the adjacent `data` directory.

Versions distributed before this update feature must be upgraded manually once.

## Verification

`npm test` includes release-script tests against temporary Git repositories and a local bare remote, plus update-state and recovery acknowledgement tests. It does not push to GitHub.

Run `npm run build` first, then `node tools/verify-updates-desktop.mjs`. This builds two signed debug NSIS installers with a unique test application identifier, temporary signing key, isolated Cargo target directory, and isolated installation directory. It verifies update checks, shared operations, signature rejection, a real locked-backup failure, the 30-second backup timeout, installation, restart, and unsaved-buffer recovery. It uninstalls the fixture afterwards and keeps evidence under `.verification/updates-*/`. The production build cannot use the loopback endpoint override used by this test.
