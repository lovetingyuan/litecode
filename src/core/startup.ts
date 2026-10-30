// Keep this module dependency-free so the entry point can run before the workbench loads.
export function waitForStartupPaint(): Promise<void> {
  if (performance.getEntriesByName("first-paint", "paint").length) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (PerformanceObserver.supportedEntryTypes.includes("paint")) {
      const observer = new PerformanceObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe({ type: "paint", buffered: true });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }
  });
}

export function startupMark(phase: string, durationMs?: number) {
  const elapsedMs = Math.round(performance.now() * 10) / 10;
  const record = {
    phase,
    elapsedMs,
    ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs * 10) / 10 }),
  };
  performance.mark(`startup:${phase}`, { detail: record });
  console.info("[startup]", JSON.stringify(record));
}

export async function startupStep<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    startupMark(phase, performance.now() - started);
  }
}
