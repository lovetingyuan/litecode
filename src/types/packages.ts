export type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

export type PackageDependency = {
  name: string;
  declared: string;
  section: DependencySection;
  registryName: string | null;
  registryVersion: string;
};

export type PackageManifest = {
  name: string;
  version: string;
  description: string;
  license: string;
  private: boolean;
  packageManager: string;
  dependencies: PackageDependency[];
  scripts: [string, string][];
};

export type PackageSnapshot = {
  directory: string;
  installed: Record<string, string>;
  warnings: string[];
};
export type PackageRegistry = {
  latest: string | null;
  repository: string | null;
  warnings: string[];
  errors: string[];
};
