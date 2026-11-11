import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkReleaseTree,
  committedVersionFiles,
  git,
  normalizeVersion,
  readVersions,
  remoteTagRefs,
  versionContents,
  versionFiles,
  withReleaseLock,
} from "./release.mjs";

const mainRef = "refs/heads/main";

function versionCommitParent(cwd, commit, message) {
  const [parent, subject] = git(cwd, ["show", "-s", "--format=%P%n%s", commit])
    .trimEnd()
    .split("\n");
  if (!parent || parent.includes(" ") || subject !== message) {
    return undefined;
  }
  const changed = git(cwd, ["diff", "--name-only", "--no-renames", parent, commit])
    .trim()
    .split("\n");
  return changed.every((name) => versionFiles.includes(name)) ? parent : undefined;
}

function readRollbackTag(cwd, failed, failedHead) {
  const tag = `v${failed}`;
  const ref = `refs/tags/${tag}`;
  const localObject = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", ref])
    .split("\n")
    .find((line) => line.startsWith(`${ref} `))
    ?.trim()
    .split(" ")[1];
  const remote = remoteTagRefs(cwd, ref);
  const remoteObject = remote.get(ref);
  if (localObject && remoteObject && localObject !== remoteObject) {
    throw new Error(`Local and remote tags differ for ${tag}.`);
  }
  const target = localObject
    ? git(cwd, ["rev-parse", `${localObject}^{commit}`]).trim()
    : (remote.get(`${ref}^{}`) ?? remoteObject);
  if (
    target &&
    target !== failedHead &&
    (git(cwd, ["merge-base", target, failedHead]).trim() !== target ||
      readVersions(committedVersionFiles(cwd, target)) !== failed)
  ) {
    throw new Error(`${tag} must point to a commit on main with version ${failed}.`);
  }
  return { ref, localObject, remoteObject };
}

async function createRollbackCommit(cwd, base, files, version, message) {
  const temp = path.join(cwd, "tmp");
  await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(path.join(temp, "release-rollback-"));
  try {
    // Prepare the commit in an isolated index so a failure leaves the checkout clean.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, "index") };
    git(cwd, ["read-tree", base], undefined, env);
    const entries = git(cwd, ["ls-tree", "-r", base, "--", ...versionFiles])
      .trimEnd()
      .split("\n");
    const indexInfo = entries.map((entry) => {
      const [object, name] = entry.split("\t");
      const mode = object.split(" ")[0];
      const contents = versionContents(name, files.get(name), version);
      const hash = git(cwd, ["hash-object", "-w", "--path", name, "--stdin"], contents).trim();
      return `${mode} ${hash}\t${name}\n`;
    });
    git(cwd, ["update-index", "--index-info"], indexInfo.join(""), env);
    const tree = git(cwd, ["write-tree"], undefined, env).trim();
    return git(cwd, ["commit-tree", tree, "-p", base, "-m", message]).trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pushRollback(cwd, upstream, commit, ref, remoteObject) {
  try {
    git(cwd, [
      "push",
      "--atomic",
      "--no-follow-tags",
      `--force-with-lease=${mainRef}:${upstream}`,
      // An empty lease rejects a tag created after the lookup.
      `--force-with-lease=${ref}:${remoteObject ?? ""}`,
      "origin",
      `${commit}:${mainRef}`,
      `:${ref}`,
    ]);
  } catch (error) {
    throw new Error(
      "Rollback push failed. Resolve the Git error and retry with the same versions.",
      {
        cause: error,
      },
    );
  }
}

export async function rollbackRelease(cwd, input, restoreInput) {
  const restore = restoreInput.trim().replace(/^v/, "");
  const failed = normalizeVersion(input, restore);
  const tag = `v${failed}`;
  const message = `revert(release): ${tag}`;

  await checkReleaseTree(cwd);
  const base = git(cwd, ["rev-parse", "HEAD"]).trim();
  git(cwd, ["fetch", "--no-tags", "origin", `+${mainRef}:refs/remotes/origin/main`]);
  const upstream = git(cwd, ["rev-parse", "refs/remotes/origin/main"]).trim();
  const files = committedVersionFiles(cwd, base);
  const current = readVersions(files);
  // A rejected push can leave the rollback commit ready for the next invocation.
  const failedHead = current === failed ? base : versionCommitParent(cwd, base, message);
  if (
    !failedHead ||
    (failedHead !== base &&
      (current !== restore || readVersions(committedVersionFiles(cwd, failedHead)) !== failed))
  ) {
    throw new Error(`Cannot roll back ${tag} from main at version ${current}.`);
  }
  if (
    upstream !== base &&
    upstream !== failedHead &&
    upstream !== versionCommitParent(cwd, failedHead, `chore(release): ${tag}`)
  ) {
    throw new Error("Sync local main with origin/main before rolling back.");
  }

  const { ref, localObject, remoteObject } = readRollbackTag(cwd, failed, failedHead);
  let commit = base;
  if (current === failed) {
    commit = await createRollbackCommit(cwd, base, files, restore, message);
    await checkReleaseTree(cwd);
    if (git(cwd, ["rev-parse", "HEAD"]).trim() !== base) {
      throw new Error("HEAD changed during rollback. Run the rollback command again.");
    }
    git(cwd, ["merge", "--ff-only", commit]);
  }
  if (upstream !== commit || remoteObject) {
    pushRollback(cwd, upstream, commit, ref, remoteObject);
  }
  if (localObject) {
    git(cwd, ["update-ref", "-d", ref, localObject]);
  }
  return { tag, restore };
}

async function main(args) {
  if (args.length !== 2) {
    throw new Error("Usage: npm run release:rollback -- <failed-version> <restore-version>");
  }
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const { tag, restore } = await withReleaseLock(cwd, () => rollbackRelease(cwd, ...args));
  console.log(`Rolled back ${tag}. Restored main to version ${restore}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
