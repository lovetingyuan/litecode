import { useEffect, useState } from "react";
import { call, errorMessage } from "../core/bridge";
import { models } from "../editor/documents";
import { useApp } from "../store/store";
import type { Doc } from "../types/types";
import type {
  PackageDependency,
  PackageManifest,
  PackageRegistry,
  PackageSnapshot,
} from "../types/packages";
import { parseManifest } from "./manifest";
import { clearPackageRegistry, packageRegistry } from "./registry";

export function usePackageManager(doc: Doc) {
  const root = useApp((state) => state.root);
  const view = useApp((state) => state.view);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<PackageSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registry, setRegistry] = useState<Record<string, PackageRegistry>>({});
  let manifest: PackageManifest | undefined;
  let parseError = "";
  try {
    manifest = parseManifest(models.get(doc.id)?.getValue() ?? "");
  } catch (error) {
    parseError = errorMessage(error);
  }
  useEffect(() => {
    if (!root || !doc.path || view !== "editor") {
      return;
    }
    let disposed = false;
    setSnapshotLoading(true);
    setSnapshotError("");
    void call<PackageSnapshot>("package_snapshot", { root, manifestPath: doc.path })
      .then((value) => {
        if (!disposed) {
          // Returning from the terminal must not reload registry data if local data is unchanged.
          setSnapshot((current) =>
            JSON.stringify(current) === JSON.stringify(value) ? current : value,
          );
        }
      })
      .catch((error) => {
        if (!disposed) {
          setSnapshot(undefined);
          setSnapshotError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!disposed) {
          setSnapshotLoading(false);
        }
      });
    return () => {
      disposed = true;
      setSnapshotLoading(false);
    };
  }, [root, view, doc.path, doc.version, doc.revision, revision]);

  const manifestText = models.get(doc.id)?.getValue() ?? "";
  useEffect(() => {
    if (!snapshot) {
      return;
    }
    let dependencies: PackageDependency[];
    try {
      dependencies = parseManifest(manifestText).dependencies.filter(
        (dependency) => dependency.registryName,
      );
    } catch {
      return;
    }
    let disposed = false;
    setRegistryLoading(true);
    setRegistry({});
    let index = 0;
    async function worker() {
      while (!disposed && index < dependencies.length) {
        const dependency = dependencies[index++];
        let result: PackageRegistry;
        try {
          result = await packageRegistry(dependency, snapshot?.installed[dependency.name]);
        } catch (error) {
          result = { latest: null, repository: null, warnings: [], errors: [errorMessage(error)] };
        }
        if (!disposed) {
          setRegistry((state) => ({
            ...state,
            [`${dependency.section}:${dependency.name}`]: result,
          }));
        }
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(4, dependencies.length) }, () => worker()),
    ).finally(() => {
      if (!disposed) {
        setRegistryLoading(false);
      }
    });
    return () => {
      disposed = true;
      setRegistryLoading(false);
    };
  }, [manifestText, snapshot, revision]);

  return {
    root,
    manifest,
    snapshot,
    registry,
    loading: snapshotLoading || registryLoading,
    error: parseError || snapshotError,
    refresh: () => {
      clearPackageRegistry();
      setRevision((value) => value + 1);
    },
  };
}
