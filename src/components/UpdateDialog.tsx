import workbenchStyles from "../styles/workbench.module.css";
import updateDialogStyles from "./UpdateDialog.module.css";
import { Dialog } from "@base-ui/react/dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdates, installUpdate, updateLocked, useUpdates } from "../core/updates";
import { errorMessage } from "../core/bridge";
import { actionButtonClass, Icon } from "./ui";

export function UpdateButton() {
  const version = useUpdates((s) => s.version);
  if (!version) {
    return null;
  }
  return (
    <button
      className={`${actionButtonClass} primary bg-focus text-foreground-strong rounded-[2px] py-[5px] px-[14px] ${workbenchStyles["primary"]} update-button ${updateDialogStyles["update-button"]}`}
      title={`LiteCode ${version} is available`}
      onClick={() => useUpdates.setState({ open: true })}
    >
      <Icon name="cloud-download" /> Update Available
    </button>
  );
}

export function UpdateDialog() {
  const s = useUpdates();
  const busy = s.phase === "checking" || s.phase === "downloading" || updateLocked(s.phase);
  const status =
    s.phase === "checking"
      ? "Checking for updates…"
      : s.phase === "current"
        ? "You are using the latest version."
        : s.phase === "downloading"
          ? `Downloading… ${(s.downloaded / 1048576).toFixed(1)} MB${s.total ? ` / ${(s.total / 1048576).toFixed(1)} MB` : ""}`
          : s.phase === "preparing"
            ? "Saving all editor windows before installing…"
            : s.phase === "installing"
              ? "Installing update… LiteCode will reopen automatically."
              : s.version
                ? `LiteCode ${s.version} is available.`
                : "Check for a new version of LiteCode.";
  const openLink = (url: string) =>
    void openUrl(url).catch((error) => useUpdates.setState({ error: errorMessage(error) }));
  return (
    <>
      <Dialog.Root open={s.open} onOpenChange={(open) => useUpdates.setState({ open })}>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop fixed inset-0 bg-backdrop z-[150]" />
          <Dialog.Popup
            className={`modal-panel fixed top-[50%] left-[50%] bg-widget border border-strong rounded-[6px] w-120 max-w-[90vw] p-6 z-[151] ${workbenchStyles["modal-panel"]} update-panel w-140 max-h-[85vh] overflow-y-auto ${updateDialogStyles["update-panel"]}`}
          >
            <Dialog.Title>LiteCode Updates</Dialog.Title>
            <Dialog.Description>
              {s.currentVersion ? `Current version: ${s.currentVersion}` : "Application updates"}
            </Dialog.Description>
            <p role="status" aria-live="polite">
              {status}
            </p>
            {s.error && (
              <p role="alert" className="update-error text-git-deleted">
                {s.error}
              </p>
            )}
            {s.version && (
              <section
                className="max-h-64 overflow-y-auto my-4 pr-2"
                aria-label={`Release notes for ${s.version}`}
              >
                <h3 className="font-semibold mb-2">What’s new in {s.version}</h3>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    a: ({ href, children }) =>
                      href && /^https?:\/\//i.test(href) ? (
                        <a
                          href={href}
                          onClick={(event) => {
                            event.preventDefault();
                            openLink(href);
                          }}
                        >
                          {children}
                        </a>
                      ) : (
                        <span>{children}</span>
                      ),
                    img: ({ alt }) => <span>{alt}</span>,
                  }}
                >
                  {s.notes || "No release notes provided."}
                </Markdown>
              </section>
            )}
            {s.phase === "downloading" &&
              (s.total ? (
                <progress
                  className={`update-progress block w-full h-2 overflow-hidden border-0 rounded-[4px] bg-strong text-focus ${updateDialogStyles["update-progress"]}`}
                  max={s.total}
                  value={s.downloaded}
                  aria-label="Update download progress"
                />
              ) : (
                <p>Downloading the installer…</p>
              ))}
            {s.version && (
              <p>
                {s.portable
                  ? "Portable edition: download the portable ZIP from GitHub and keep your data directory."
                  : "LiteCode will save recovery data for all windows, close, install the update, and reopen. Running terminal tasks will stop."}
              </p>
            )}
            <div className="flex justify-end flex-wrap gap-2 mt-5">
              <button
                className={actionButtonClass}
                disabled={busy}
                onClick={() => void checkForUpdates()}
              >
                Check Again
              </button>
              {s.version && (
                <button
                  className={`${actionButtonClass} primary bg-focus text-foreground-strong rounded-[2px] py-[5px] px-[14px] ${workbenchStyles["primary"]}`}
                  disabled={busy}
                  onClick={() =>
                    s.portable
                      ? openLink(
                          `https://github.com/lovetingyuan/litecode/releases/tag/v${s.version}`,
                        )
                      : void installUpdate()
                  }
                >
                  {s.portable ? "Open Release Downloads" : "Download and Install"}
                </button>
              )}
              <Dialog.Close className={actionButtonClass}>Close</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {updateLocked(s.phase) && (
        <div
          className="update-lock fixed inset-0 z-[200] bg-shadow grid place-items-center p-6"
          role="alert"
          aria-live="assertive"
        >
          <div
            className={`update-panel w-140 max-h-[85vh] overflow-y-auto ${updateDialogStyles["update-panel"]} update-install-status p-6 border border-strong rounded-[4px] bg-widget text-foreground`}
          >
            {status}
          </div>
        </div>
      )}
    </>
  );
}
