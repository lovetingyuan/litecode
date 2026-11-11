import { describe, expect, it } from "vitest";
import { finalizeManifest } from "./finalize-updater.mjs";

function fixture() {
  const notes = "## Fixed\n\n- Preserve `code`, $HOME and 中文.\n# Markdown comment";
  const keys = [
    "windows-x86_64",
    "windows-x86_64-nsis",
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
  ];
  const assets = keys.map((key, id) => ({
    name: `${key}.bundle`,
    state: "uploaded",
    size: 100,
    id,
    url: `https://api.github.com/repos/example/app/releases/assets/${id}`,
    browser_download_url: `https://github.com/example/app/releases/download/v0.2.0/${key}.bundle`,
  }));
  const manifest = {
    version: "0.2.0",
    notes: "",
    pub_date: "2026-11-10T18:06:23.562Z",
    platforms: Object.fromEntries(
      keys.map((key, index) => [key, { signature: `signature-${key}`, url: assets[index].url }]),
    ),
  };
  return {
    manifest,
    release: { tag_name: "v0.2.0", prerelease: false, body: notes, assets },
    notes,
  };
}

describe("updater manifest finalization", () => {
  it("writes Markdown and public URLs for all platforms while preserving signatures and metadata", () => {
    const { manifest, release, notes } = fixture();
    const before = structuredClone(manifest);
    const result = finalizeManifest(manifest, release, notes);
    expect(result.notes).toBe(notes);
    expect(result.version).toBe(manifest.version);
    expect(result.pub_date).toBe(manifest.pub_date);
    expect(Object.keys(result.platforms)).toEqual(Object.keys(manifest.platforms));
    Object.entries(result.platforms).forEach(([key, entry], index) => {
      expect(entry.signature).toBe(manifest.platforms[key].signature);
      expect(entry.url).toBe(release.assets[index].browser_download_url);
    });
    expect(manifest).toEqual(before);
    expect(finalizeManifest(result, release, notes)).toEqual(result);
  });

  it("rejects mismatched versions, notes and incomplete signed assets", () => {
    const { manifest, release, notes } = fixture();
    expect(() => finalizeManifest({ ...manifest, version: "0.1.8" }, release, notes)).toThrow(
      "version",
    );
    expect(() => finalizeManifest(manifest, { ...release, prerelease: true }, notes)).toThrow(
      "stable",
    );
    expect(() => finalizeManifest(manifest, release, "")).toThrow("empty");
    expect(() => finalizeManifest(manifest, release, "Different notes")).toThrow("does not match");
    expect(() =>
      finalizeManifest(manifest, { ...release, assets: release.assets.slice(1) }, notes),
    ).toThrow("asset");
    release.assets[0].state = "new";
    expect(() => finalizeManifest(manifest, release, notes)).toThrow("asset");
    release.assets[0].state = "uploaded";
    manifest.platforms["windows-x86_64"].signature = "";
    expect(() => finalizeManifest(manifest, release, notes)).toThrow("signed");
    delete manifest.platforms["windows-x86_64"];
    expect(() => finalizeManifest(manifest, release, notes)).toThrow("platform");
  });
});
