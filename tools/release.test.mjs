import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentVersion, normalizeVersion, updateVersions } from "./release.mjs";

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("release inputs", () => {
  it("accepts only increasing stable versions", () => {
    expect(normalizeVersion(" v0.10.0 ", "0.9.9")).toBe("0.10.0");
    for (const input of ["0.9.9", "0.1.0", "0.10.0-beta.1", "01.2.3", "x.y.z", "1.0.0; echo bad"]) {
      expect(() => normalizeVersion(input, "0.9.9")).toThrow();
    }
  });
  it("updates only application versions in both locks", async () => {
    await mkdir("tmp", { recursive: true });
    const directory = await mkdtemp(path.resolve("tmp/litecode-versions-"));
    temporary.push(directory);
    await mkdir(path.join(directory, "src-tauri"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({
        version: "0.1.0",
        packages: { "": { version: "0.1.0" }, "node_modules/example": { version: "9.9.9" } },
      }),
    );
    await writeFile(
      path.join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    await writeFile(
      path.join(directory, "src-tauri/Cargo.toml"),
      '[package]\nname = "litecode"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(directory, "src-tauri/Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "example"\nversion = "9.9.9"\n\n[[package]]\nname = "litecode"\nversion = "0.1.0"\n',
    );
    await updateVersions(directory, "0.2.0");
    expect(await currentVersion(directory)).toBe("0.2.0");
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(lock.packages["node_modules/example"].version).toBe("9.9.9");
    expect(await readFile(path.join(directory, "src-tauri/Cargo.lock"), "utf8")).toContain(
      'name = "example"\nversion = "9.9.9"',
    );
    await writeFile(
      path.join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    await expect(currentVersion(directory)).rejects.toThrow("版本不一致");
  });
});
