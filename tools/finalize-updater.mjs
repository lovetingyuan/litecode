import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNotes } from "./release.mjs";

const requiredPlatforms = [
  "windows-x86_64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
];

export function finalizeManifest(manifest, release, notes) {
  const version = release.tag_name?.slice(1);
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) ||
    release.prerelease ||
    manifest.version !== version
  ) {
    throw new Error("Manifest version must match a stable release tag.");
  }
  const body = normalizeNotes(notes);
  if (normalizeNotes(release.body) !== body) {
    throw new Error("Release body does not match the release notes.");
  }
  if (!manifest.platforms || requiredPlatforms.some((key) => !manifest.platforms[key])) {
    throw new Error("Manifest is missing a required update platform.");
  }
  const assets = release.assets.filter((asset) => asset.state === "uploaded" && asset.size > 0);
  const platforms = {};
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const asset = assets.find(
      (item) => entry.url === item.url || entry.url === item.browser_download_url,
    );
    if (
      !asset ||
      !asset.browser_download_url?.startsWith("https://github.com/") ||
      typeof entry.signature !== "string" ||
      !entry.signature.trim()
    ) {
      throw new Error(`Missing signed release asset for platform ${key}.`);
    }
    platforms[key] = { ...entry, url: asset.browser_download_url };
  }
  return { ...manifest, notes: body, platforms };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", windowsHide: true });
}

async function main(args) {
  const [tag, notesFile] = args;
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    args.length !== 2 ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")
  ) {
    throw new Error(
      "Usage: GITHUB_REPOSITORY=owner/repo node tools/finalize-updater.mjs vX.Y.Z notes-file",
    );
  }
  const release = JSON.parse(gh(["api", `repos/${repository}/releases/tags/${tag}`]));
  if (!release.draft) throw new Error("Only release drafts can be finalized.");
  release.assets = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases/${release.id}/assets?per_page=100`,
    ]),
  ).flat();
  const asset = release.assets.find(
    (item) => item.name === "latest.json" && item.state === "uploaded" && item.size > 0,
  );
  if (!asset) throw new Error("Release has no uploaded latest.json.");
  const original = gh([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `repos/${repository}/releases/assets/${asset.id}`,
  ]);
  const manifest = JSON.parse(original);
  const notes = await readFile(notesFile, "utf8");
  const finalized = finalizeManifest(manifest, release, notes);
  const directory = fileURLToPath(new URL(`../tmp/release/${tag}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "latest.original.json"), original);
  const destination = path.join(directory, "latest.json");
  await writeFile(destination, `${JSON.stringify(finalized, null, 2)}\n`);
  if (JSON.stringify(manifest) !== JSON.stringify(finalized)) {
    gh(["release", "upload", tag, destination, "--repo", repository, "--clobber"]);
  }
  const uploaded = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases/${release.id}/assets?per_page=100`,
    ]),
  )
    .flat()
    .find((item) => item.name === "latest.json");
  if (!uploaded) throw new Error("Uploaded manifest could not be found.");
  const actual = JSON.parse(
    gh([
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${uploaded.id}`,
    ]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(finalized)) {
    throw new Error("Uploaded manifest does not match the verified manifest.");
  }
  console.log(`Verified ${tag}: release notes and public download URLs for all platforms.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
