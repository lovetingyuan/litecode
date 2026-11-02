import { call } from "../core/bridge";
import type { PackageDependency, PackageRegistry } from "../types/packages";

const cache = new Map<string, { time: number; request: Promise<PackageRegistry> }>();
const waiting: (() => void)[] = [];
let active = 0;

// Share both in-flight and recent requests across editor groups; cap public API traffic.
async function limited<T>(operation: () => Promise<T>) {
  if (active >= 4) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  }
}

export function packageRegistry(dependency: PackageDependency, installed?: string) {
  const key = JSON.stringify([dependency.registryName, dependency.registryVersion, installed]);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.time < 5 * 60_000) {
    return existing.request;
  }
  const request = limited(() =>
    call<PackageRegistry>("package_registry", {
      name: dependency.registryName,
      declared: dependency.registryVersion,
      installed: installed ?? null,
    }),
  );
  const entry = { request, time: Date.now() };
  cache.set(key, entry);
  // Failed or partial checks must be retryable from Refresh.
  void request.then(
    (result) => {
      if (result.errors.length && cache.get(key) === entry) {
        cache.delete(key);
      }
    },
    () => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    },
  );
  if (cache.size > 256) {
    cache.delete(cache.keys().next().value ?? "");
  }
  return request;
}

export function clearPackageRegistry() {
  cache.clear();
}
