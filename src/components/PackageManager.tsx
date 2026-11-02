import { useState } from "react";
import { errorMessage } from "../core/bridge";
import { notify } from "../store/store";
import { runPackageCommand } from "../packages/commands";
import { updateArguments } from "../packages/manifest";
import { usePackageManager } from "../packages/usePackageManager";
import type { PackageDependency } from "../types/packages";
import type { Doc } from "../types/types";
import { actionButtonClass, Icon } from "./ui";
import { PackageDependencies } from "./PackageDependencies";

export function PackageManager({ doc }: Readonly<{ doc: Doc }>) {
  const { root, manifest, snapshot, registry, error, refresh } = usePackageManager(doc);
  const [busy, setBusy] = useState(false);
  const [hideUpToDate, setHideUpToDate] = useState(false);
  const unavailable = doc.dirty || !!doc.conflict || !!doc.deleted;
  async function execute(args: string[]) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await runPackageCommand(root, doc, args);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function update(dependency: PackageDependency, latest: string) {
    await execute(updateArguments(dependency, latest));
  }
  return (
    <section
      tabIndex={-1}
      aria-label="Package manager"
      className="package-manager flex-1 min-h-0 overflow-auto bg-editor text-foreground px-6 py-5"
    >
      <div className="mx-auto max-w-300 flex flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-muted text-[12px]">
              <Icon name="package" />
              package.json
            </div>
            <h1 className="mt-2 text-[24px] font-semibold text-foreground-strong">
              {manifest?.name || "Unnamed package"}{" "}
              {manifest?.version && (
                <span className="ml-3 text-[14px] font-normal text-muted">v{manifest.version}</span>
              )}
              {manifest?.private && (
                <span className="ml-3 inline-block align-middle rounded border border-panel px-1.5 py-0.5 text-[11px] font-normal leading-none text-muted">
                  Private
                </span>
              )}
            </h1>
            {manifest?.description && (
              <p className="mt-2 text-[13px] max-w-200">{manifest.description}</p>
            )}
            {manifest && (manifest.license || !manifest.private || manifest.packageManager) && (
              <div className="mt-3 flex flex-wrap gap-4 text-muted text-[12px]">
                {manifest.license && <span>License: {manifest.license}</span>}
                {!manifest.private && <span>Public package</span>}
                {manifest.packageManager && <span>Package manager: {manifest.packageManager}</span>}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={actionButtonClass} onClick={refresh} disabled={busy}>
              <Icon name="refresh" />
              Refresh
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-error text-[13px]">
            {error}
          </p>
        )}
        {unavailable && (
          <p role="status" className="text-warning text-[13px]">
            Save package.json and resolve file conflicts before running scripts or updating
            dependencies.
          </p>
        )}
        {snapshot?.warnings.map((warning) => (
          <p key={warning} className="text-warning text-[13px]">
            {warning}
          </p>
        ))}
        {manifest && (
          <>
            <section aria-label="Dependencies" className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h2 className="text-[16px] font-semibold">
                  Dependencies{" "}
                  <span className="text-muted text-[12px]">{manifest.dependencies.length}</span>
                </h2>
                <label className="inline-flex items-center gap-2 text-[12px] text-muted cursor-pointer select-none">
                  <input
                    type="checkbox"
                    role="switch"
                    className="accent-button"
                    checked={hideUpToDate}
                    onChange={(event) => setHideUpToDate(event.target.checked)}
                  />
                  Hide up-to-date
                </label>
              </div>
              <PackageDependencies
                dependencies={manifest.dependencies}
                installed={snapshot?.installed}
                registry={registry}
                hideUpToDate={hideUpToDate}
                busy={busy}
                disabled={unavailable || !snapshot || !!error}
                update={(dependency, latest) =>
                  void update(dependency, latest).catch((error) => notify(errorMessage(error)))
                }
              />
            </section>
            <section aria-label="npm scripts">
              <h2 className="text-[16px] font-semibold mb-3">
                Scripts <span className="text-muted text-[12px]">{manifest.scripts.length}</span>
              </h2>
              {!manifest.scripts.length && (
                <p className="text-muted text-[13px]">No npm scripts defined.</p>
              )}
              <ul className="flex flex-col border-t border-panel">
                {manifest.scripts.map(([name, command]) => (
                  <li key={name} className="flex items-start gap-4 border-b border-panel px-3 py-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[13px] font-semibold">{name}</h3>
                      <pre
                        className="mt-1 whitespace-pre-wrap break-all text-muted text-[12px] select-text"
                        title={command}
                      >
                        {command}
                      </pre>
                    </div>
                    <button
                      type="button"
                      className={actionButtonClass}
                      aria-label={`Run npm script ${name}`}
                      disabled={busy || unavailable || !snapshot || !!error}
                      onClick={() => void execute(["run", "--", name])}
                    >
                      <Icon name="play" />
                      Run
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </section>
  );
}
