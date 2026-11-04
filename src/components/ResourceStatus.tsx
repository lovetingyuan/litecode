import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useResourceUsage } from "../hooks/useResourceUsage";
import { Icon } from "./ui";
import workbenchStyles from "../styles/workbench.module.css";

function formatMemory(bytes: number) {
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib.toFixed(1)} MiB`;
}

export function ResourceStatus() {
  const [open, setOpen] = useState(false);
  const { usage, unavailable } = useResourceUsage(open);
  const windowTitle = import.meta.env.DEV ? "Local window (Development)" : "Local window";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`remote-indicator flex items-center text-foreground-strong mr-[5px] ${import.meta.env.DEV ? "bg-remote-development" : "bg-button"} ${workbenchStyles["resource-trigger"]}`}
        title={`${windowTitle} — Show Resource Usage`}
        aria-label="Show LiteCode Resource Usage"
      >
        <Icon name="remote" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="z-90"
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <Popover.Popup
            className={`flex flex-col gap-3 w-64 max-w-[min(calc(100vw_-_16px),_var(--available-width))] max-h-[var(--available-height)] overflow-auto p-3 bg-widget text-foreground border border-strong rounded-[4px] ${workbenchStyles["workspace-popup"]}`}
            initialFocus={false}
          >
            <Popover.Title className="text-[13px] font-semibold">
              LiteCode Resources
            </Popover.Title>
            <Popover.Description className="text-[12px] text-subtle">
              App and WebView processes
            </Popover.Description>
            {unavailable ? (
              <p className="text-[12px]" role="status">
                Resource usage unavailable
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-2 text-[12px]">
                <dt>Memory</dt>
                <dd
                  className="text-right tabular-nums"
                  title="Private working set, same as Task Manager"
                >
                  {usage ? formatMemory(usage.memoryBytes) : "Loading…"}
                </dd>
                <dt>CPU</dt>
                <dd className="text-right tabular-nums" title="Percentage of total CPU capacity">
                  {usage?.cpuPercent == null ? "Measuring…" : `${usage.cpuPercent.toFixed(1)}%`}
                </dd>
              </dl>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
