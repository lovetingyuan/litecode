import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, type ReactNode } from "react";
import { errorMessage } from "../core/bridge";
import { notify } from "../store/store";
import {
  dependencySections,
  githubUrl,
  isDependencyCurrent,
  isMajorUpgrade,
} from "../packages/manifest";
import type { DependencySection, PackageDependency, PackageRegistry } from "../types/packages";
import { actionButtonClass, Icon } from "./ui";

export function PackageLink({
  href,
  children,
  label,
}: Readonly<{ href: string; children: ReactNode; label: string }>) {
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1 text-link hover:underline"
      onClick={(event) => {
        event.preventDefault();
        void openUrl(href).catch((error) => notify(errorMessage(error)));
      }}
    >
      {children}
    </a>
  );
}

export function PackageDependencies({
  dependencies,
  installed,
  registry,
  hideUpToDate,
  busy,
  disabled,
  update,
}: Readonly<{
  dependencies: PackageDependency[];
  installed?: Record<string, string>;
  registry: Record<string, PackageRegistry>;
  hideUpToDate: boolean;
  busy: boolean;
  disabled: boolean;
  update: (dependency: PackageDependency, latest: string) => void;
}>) {
  const [collapsed, setCollapsed] = useState<Partial<Record<DependencySection, boolean>>>({});
  if (!dependencies.length) {
    return <p className="text-muted">No dependencies declared.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px] [&_th]:font-medium [&_th]:text-muted [&_th:not([scope=rowgroup])]:py-2 [&_td]:py-2 [&_th:not([scope=rowgroup])]:px-3 [&_td]:px-3 [&_td]:border-b [&_td]:border-panel">
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Declared</th>
            <th scope="col">Installed</th>
            <th scope="col">Latest on npm</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {dependencySections.map((section) => {
          const entries = dependencies.filter((dependency) => dependency.section === section);
          if (!entries.length) {
            return null;
          }
          const visible = entries.filter(
            (dependency) =>
              !hideUpToDate ||
              !isDependencyCurrent(
                dependency,
                installed?.[dependency.name],
                registry[`${section}:${dependency.name}`]?.latest,
              ),
          );
          const expanded = !collapsed[section];
          return (
            <tbody key={section}>
              <tr>
                {/* Keep spacing outside the full-width button so adjacent groups remain distinct. */}
                <th colSpan={5} scope="rowgroup" className="p-0 py-1 text-[14px]">
                  <button
                    type="button"
                    className="flex items-center gap-1 w-full h-9 px-3 py-0 rounded-none bg-table-header text-left text-foreground hover:bg-hover"
                    aria-expanded={expanded}
                    onClick={() =>
                      setCollapsed((state) => ({ ...state, [section]: !state[section] }))
                    }
                  >
                    <Icon name={expanded ? "chevron-down" : "chevron-right"} />
                    {section}{" "}
                    <span className="text-muted">
                      ({visible.length} / {entries.length})
                    </span>
                  </button>
                </th>
              </tr>
              {expanded && !visible.length && (
                <tr>
                  <td colSpan={5} className="text-muted">
                    All dependencies in this group are up to date.
                  </td>
                </tr>
              )}
              {expanded &&
                visible.map((dependency) => {
                  const metadata = registry[`${section}:${dependency.name}`];
                  const actual = installed?.[dependency.name];
                  const latest = metadata?.latest;
                  const repository = githubUrl(metadata?.repository ?? null);
                  const major =
                    !!latest && isMajorUpgrade(actual ?? dependency.registryVersion, latest);
                  const warnings = metadata?.warnings.join("\n\n");
                  const errors = metadata?.errors.join("\n\n");
                  const current = isDependencyCurrent(dependency, actual, latest);
                  let latestLabel = "Not on npm";
                  if (dependency.registryName) {
                    latestLabel = metadata ? "Unavailable" : "Loading…";
                  }
                  return (
                    <tr key={dependency.name} className="hover:bg-hover">
                      <th scope="row" className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <PackageLink
                            href={`https://www.npmjs.com/package/${encodeURIComponent(dependency.registryName ?? dependency.name)}`}
                            label={`View ${dependency.name} on npm`}
                          >
                            {dependency.name}
                          </PackageLink>
                          {repository ? (
                            <PackageLink
                              href={repository}
                              label={`Open ${dependency.name} on GitHub`}
                            >
                              <Icon name="github" />
                            </PackageLink>
                          ) : (
                            <button
                              type="button"
                              disabled
                              title="No GitHub repository available"
                              aria-label={`No GitHub repository for ${dependency.name}`}
                              className="inline-flex text-disabled"
                            >
                              <Icon name="github" />
                            </button>
                          )}
                        </span>
                      </th>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <code className="break-all">{dependency.declared}</code>
                          {warnings && (
                            <span
                              className="inline-flex text-warning"
                              title={warnings}
                              aria-label={warnings}
                              tabIndex={0}
                            >
                              <Icon name="warning" />
                            </span>
                          )}
                          {errors && (
                            <span
                              className="inline-flex text-muted"
                              title={errors}
                              aria-label={errors}
                              tabIndex={0}
                            >
                              <Icon name="info" />
                            </span>
                          )}
                        </span>
                      </td>
                      <td
                        className="whitespace-nowrap font-mono text-muted"
                        title={installed ? "Version from node_modules" : "Reading node_modules"}
                      >
                        {actual ?? (installed ? "Not installed" : "Loading…")}
                      </td>
                      <td
                        className={`whitespace-nowrap font-mono ${major ? "text-git-added" : ""}`}
                        title={major ? "Major version upgrade" : errors}
                      >
                        {latest ?? latestLabel}
                        {major && <span className="sr-only"> (major upgrade)</span>}
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className={`${actionButtonClass} compact`}
                          disabled={
                            disabled || busy || !latest || current || !dependency.registryName
                          }
                          title={
                            disabled
                              ? "Save package.json and resolve conflicts before updating"
                              : `Update ${dependency.name} to ${latest ?? "the latest version"}`
                          }
                          onClick={() => latest && update(dependency, latest)}
                        >
                          <Icon name={current ? "check" : "arrow-up"} />
                          {current ? "Up to date" : "Update"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
