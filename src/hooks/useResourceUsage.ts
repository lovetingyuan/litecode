import { useEffect, useRef, useState } from "react";
import { call } from "../core/bridge";
import type { ResourceUsage } from "../types/resourceUsage";

export function useResourceUsage(open: boolean) {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Keep requests serial even when the popover is quickly closed and reopened.
  const pending = useRef(Promise.resolve());

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    setUsage(null);
    setUnavailable(false);
    if (!open || !visible) {
      return;
    }
    let disposed = false;
    let reset = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function poll() {
      pending.current = pending.current.then(async () => {
        if (disposed) {
          return;
        }
        const started = performance.now();
        try {
          const next = await call<ResourceUsage>("get_app_resource_usage", { reset });
          if (!disposed) {
            setUsage(next);
            setUnavailable(false);
            reset = false;
          }
        } catch {
          if (!disposed) {
            setUsage(null);
            setUnavailable(true);
            reset = true;
          }
        }
        if (!disposed) {
          timer = setTimeout(poll, Math.max(0, 1000 - (performance.now() - started)));
        }
      });
    }
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [open, visible]);

  return { usage, unavailable };
}
