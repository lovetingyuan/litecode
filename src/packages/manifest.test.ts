import { describe, expect, it } from "vitest";
import {
  githubUrl,
  isDependencyCurrent,
  isMajorUpgrade,
  parseManifest,
  registryTarget,
  updateArguments,
} from "./manifest";

describe("Package manifests and update commands", () => {
  it("treats the latest installation as current when the declaration allows it", () => {
    const metadata = { latest: "19.0.0", declaredAllowsLatest: true };
    expect(isDependencyCurrent("19.0.0", metadata)).toBe(true);
    expect(isDependencyCurrent("19.0.0", undefined)).toBe(false);
    expect(isDependencyCurrent(undefined, metadata)).toBe(false);
    expect(isDependencyCurrent("18.0.0", metadata)).toBe(false);
    expect(isDependencyCurrent("19.0.0", { ...metadata, declaredAllowsLatest: false })).toBe(false);
  });
  it("keeps dependency sections, aliases and non-registry dependencies distinct", () => {
    const manifest = parseManifest(
      JSON.stringify({
        name: "example",
        version: "1.2.3",
        private: true,
        dependencies: {
          react: "^18.0.0",
          editor: "npm:@scope/editor@~2.0.0",
          local: "file:../local",
        },
        devDependencies: { vite: "6.0.0" },
        peerDependencies: { react: ">=18" },
        optionalDependencies: { native: "*" },
        scripts: { dev: "vite --host" },
      }),
    );
    expect(manifest.dependencies).toHaveLength(6);
    expect(manifest.scripts).toEqual([["dev", "vite --host"]]);
    expect(manifest.dependencies[1]).toMatchObject({
      registryName: "@scope/editor",
      registryVersion: "~2.0.0",
    });
    expect(manifest.dependencies[2].registryName).toBeNull();
    expect(registryTarget("local", "workspace:*").registryName).toBeNull();
    expect(registryTarget("local", "owner/repo").registryName).toBeNull();
    expect(() => parseManifest('{"dependencies":{"react":123}}')).toThrow("Expected a string");
    expect(() => parseManifest("null")).toThrow("Expected a JSON object");
  });

  it("preserves the dependency section, range prefix and npm alias during upgrades", () => {
    const [dependency] = parseManifest(
      '{"devDependencies":{"editor":"npm:@scope/editor@~2.0.0"}}',
    ).dependencies;
    expect(updateArguments(dependency, "3.1.0")).toEqual([
      "install",
      "--save-dev",
      "--save-prefix=~",
      "editor@npm:@scope/editor@3.1.0",
    ]);
    const [peer] = parseManifest('{"peerDependencies":{"react":"18.0.0"}}').dependencies;
    expect(updateArguments(peer, "19.0.0")).toEqual([
      "install",
      "--save-peer",
      "--save-exact",
      "react@19.0.0",
    ]);
    expect(() => updateArguments(peer, "19.0.0; echo injected")).toThrow("valid latest version");
    const [local] = parseManifest('{"dependencies":{"local":"file:../local"}}').dependencies;
    expect(() => updateArguments(local, "1.0.0")).toThrow("Only npm registry");
  });

  it("only highlights higher major versions and only links to actual GitHub hosts", () => {
    expect(isMajorUpgrade("^18.2.0", "19.1.0")).toBe(true);
    expect(isMajorUpgrade("19.0.0", "19.2.0")).toBe(false);
    expect(isMajorUpgrade("20.0.0", "19.2.0")).toBe(false);
    expect(githubUrl("git+https://github.com/facebook/react.git")).toBe(
      "https://github.com/facebook/react",
    );
    expect(githubUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(githubUrl("https://github.com.attacker.test/owner/repo")).toBeNull();
    expect(githubUrl("javascript:alert(1)")).toBeNull();
  });
});
