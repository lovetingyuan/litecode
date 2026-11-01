import { useEffect } from "react";
import { Popover } from "@base-ui/react/popover";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initializeHtmlPreviews, stopHttpService, useHtmlPreviews } from "../core/htmlPreview";
import { errorMessage } from "../core/bridge";
import { notify } from "../store/store";
import { actionButtonClass, Icon } from "./ui";
import workbenchStyles from "../styles/workbench.module.css";

export function HttpServiceStatus() {
  const services = useHtmlPreviews((state) => state.services);
  const stopping = useHtmlPreviews((state) => state.stopping);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializeHtmlPreviews()
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          cleanup = stop;
        }
      })
      .catch((error) => notify(`Could not load HTTP services: ${errorMessage(error)}`));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  if (!services.length) {
    return null;
  }
  const label =
    services.length === 1 ? `HTTP: ${services[0].port}` : `HTTP: ${services.length} servers`;
  return (
    <Popover.Root>
      <Popover.Trigger
        className={`status-item ${workbenchStyles["status-item"]}`}
        title="Manage HTML preview HTTP services"
        aria-label="HTTP Services"
      >
        <Icon name="radio-tower" />
        {label}
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
            className={`flex flex-col gap-3 w-110 max-w-[min(calc(100vw_-_16px),_var(--available-width))] max-h-[var(--available-height)] overflow-auto p-3 bg-widget text-foreground border border-strong rounded-[4px] ${workbenchStyles["workspace-popup"]}`}
            aria-label="Running HTTP services"
            initialFocus={false}
          >
            <Popover.Title className="text-[13px] font-semibold">HTTP Services</Popover.Title>
            {services.map((service) => (
              <section
                key={service.id}
                className="flex flex-col gap-2 text-[12px] border-t border-strong pt-2"
                aria-label={`HTTP service on port ${service.port}`}
              >
                <div className="break-all select-text" title="Root Directory">
                  {service.root}
                </div>
                <a
                  className="text-link break-all select-text"
                  href={service.url}
                  onClick={(event) => {
                    event.preventDefault();
                    void openUrl(service.url).catch((error) => notify(errorMessage(error)));
                  }}
                >
                  {service.url}
                </a>
                <div className="text-subtle">Port: {service.port}</div>
                <div className="flex gap-2">
                  <button
                    className={actionButtonClass}
                    disabled={stopping.includes(service.id)}
                    onClick={() =>
                      void openUrl(service.url).catch((error) => notify(errorMessage(error)))
                    }
                  >
                    Open in Browser
                  </button>
                  <button
                    className={actionButtonClass}
                    disabled={stopping.includes(service.id)}
                    onClick={() =>
                      void stopHttpService(service.id).catch((error) => notify(errorMessage(error)))
                    }
                  >
                    {stopping.includes(service.id) ? "Stopping…" : "Stop Server"}
                  </button>
                </div>
              </section>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
