import type {
  DependencySection,
  PackageDependency,
  PackageManifest,
  PackageRegistry,
} from "../types/packages";

export const dependencySections: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object in package.json.");
  }
  return Object.fromEntries(Object.entries(value));
}

function entries(value: unknown): [string, string][] {
  if (value === undefined) {
    return [];
  }
  return Object.entries(record(value)).map(([key, value]) => {
    if (typeof value !== "string") {
      throw new Error(`Expected a string for "${key}".`);
    }
    return [key, value];
  });
}

export function registryTarget(name: string, declared: string) {
  const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(declared);
  const registryName = alias?.[1] ?? name;
  const registryVersion = alias ? (alias[2] ?? "latest") : declared;
  const validName = [name, registryName].every((value) =>
    /^(?:@[\w~-]+\/)?[\w~][\w.~-]*$/.test(value),
  );
  const registry =
    validName &&
    !/^(?:file:|link:|workspace:|catalog:|patch:|https?:|git|github:|gitlab:|bitbucket:)/.test(
      registryVersion,
    ) &&
    !registryVersion.includes("/") &&
    !registryVersion.includes("\\");
  return { registryName: registry ? registryName : null, registryVersion };
}

export function parseManifest(text: string): PackageManifest {
  const value: unknown = JSON.parse(text);
  const json = record(value);
  const string = (key: string) => (typeof json[key] === "string" ? json[key] : "");
  const dependencies: PackageDependency[] = dependencySections.flatMap((section) =>
    entries(json[section]).map(([name, declared]) => ({
      name,
      declared,
      section,
      ...registryTarget(name, declared),
    })),
  );
  return {
    name: string("name"),
    version: string("version"),
    description: string("description"),
    license: string("license"),
    private: json.private === true,
    packageManager: string("packageManager"),
    dependencies,
    scripts: entries(json.scripts),
  };
}

export function githubUrl(repository: string | null) {
  if (!repository) {
    return null;
  }
  const match =
    /^(?:git\+)?(?:https?:\/\/github\.com\/|git:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github:)([\w.-]+)\/([\w.-]+)(?:[/#].*)?$/.exec(
      repository,
    );
  return match ? `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
}

export function isMajorUpgrade(current: string, latest: string) {
  const major = (version: string) => /^(?:[~^=v]\s*)?(\d+)\./.exec(version)?.[1];
  const before = major(current);
  const after = major(latest);
  return before !== undefined && after !== undefined && Number(after) > Number(before);
}

export function isDependencyCurrent(
  installed: string | undefined,
  metadata: Pick<PackageRegistry, "latest" | "declaredAllowsLatest"> | undefined,
) {
  return !!metadata?.declaredAllowsLatest && !!metadata.latest && installed === metadata.latest;
}

export function updateArguments(dependency: PackageDependency, latest: string) {
  if (!dependency.registryName || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(latest)) {
    throw new Error("Only npm registry dependencies with a valid latest version can be updated.");
  }
  const flags: Record<DependencySection, string> = {
    dependencies: "--save-prod",
    devDependencies: "--save-dev",
    peerDependencies: "--save-peer",
    optionalDependencies: "--save-optional",
  };
  const prefix = /^[~^]/.exec(dependency.registryVersion)?.[0] ?? "";
  const target = dependency.declared.startsWith("npm:")
    ? `npm:${dependency.registryName}@${latest}`
    : latest;
  return [
    "install",
    flags[dependency.section],
    prefix ? `--save-prefix=${prefix}` : "--save-exact",
    `${dependency.name}@${target}`,
  ];
}
