import { mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const signingKeyPath = path.join(homedir(), ".tauri", "litecode", "updater.key");

export async function setupUpdater() {
  const configPath = path.join(root, "src-tauri/tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const exists = await access(signingKeyPath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    if (config.plugins?.updater?.pubkey) {
      throw new Error(
        "This app already has an update public key. Restore its matching private key; generating a replacement would break existing clients.",
      );
    }
    await mkdir(path.dirname(signingKeyPath), { recursive: true, mode: 0o700 });
    // The CLI may print key material; never forward its output to the terminal.
    try {
      execFileSync(
        process.execPath,
        [
          path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
          "signer",
          "generate",
          "--ci",
          "--write-keys",
          signingKeyPath,
        ],
        { cwd: root, stdio: "pipe", windowsHide: true },
      );
    } catch {
      throw new Error("Could not generate the updater signing key. No key contents were logged.");
    }
    await chmod(signingKeyPath, 0o600);
  }
  const pubkey = (await readFile(`${signingKeyPath}.pub`, "utf8")).trim();
  if (config.plugins?.updater?.pubkey && config.plugins.updater.pubkey !== pubkey) {
    throw new Error(
      "Existing private key does not belong to the configured public key. No files were overwritten.",
    );
  }
  config.plugins.updater.pubkey = pubkey;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `Updater key ready: ${signingKeyPath}\nBack up the private key securely. Commit the public key in src-tauri/tauri.conf.json before running npm run release.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupUpdater().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
