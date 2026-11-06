import workbenchStyles from "../styles/workbench.module.css";
import updateDialogStyles from "./UpdateDialog.module.css";
import { Dialog } from "@base-ui/react/dialog";
import { lazy, Suspense, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installUpdate, updateLocked, useUpdates } from "../core/updates";
import { errorMessage } from "../core/bridge";
import { actionButtonClass, Icon } from "./ui";

const UpdateReleaseNotes = lazy(() => import("./UpdateReleaseNotes"));
function installLabel(phase: string, portable: boolean, busy: boolean) {
  if (phase === "checking") {
    return "Checking…";
  }
  if (phase === "downloading") {
    return "Downloading…";
  }
  if (busy) {
    return "Installing…";
  }
  return portable ? "Open Release Downloads" : "Download and Install";
}

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
  const [installing, setInstalling] = useState(false);
  const working = useRef(false);
  const busy =
    installing || s.phase === "checking" || s.phase === "downloading" || updateLocked(s.phase);
  async function install() {
    if (working.current || busy) {
      return;
    }
    working.current = true;
    setInstalling(true);
    try {
      await installUpdate();
    } finally {
      working.current = false;
      setInstalling(false);
    }
  }
  const releaseUrl = `https://github.com/lovetingyuan/litecode/releases/tag/v${s.version}`;
  const openLink = (url: string) =>
    void openUrl(url).catch((error) => useUpdates.setState({ error: errorMessage(error) }));
  let status;
  if (s.phase === "checking") {
    status = "Checking for updates…";
  } else if (s.phase === "current") {
    status = "You are using the latest version.";
  } else if (s.phase === "downloading") {
    status = `Downloading… ${(s.downloaded / 1048576).toFixed(1)} MB${s.total ? " / ".concat((s.total / 1048576).toFixed(1), " MB") : ""}`;
  } else if (s.phase === "preparing") {
    status = "Saving all editor windows before installing…";
  } else if (s.phase === "installing") {
    status = "Installing update… LiteCode will reopen automatically.";
  } else if (s.version) {
    status = (
      <>
        LiteCode{" "}
        <a
          href={releaseUrl}
          onClick={(event) => {
            event.preventDefault();
            openLink(releaseUrl);
          }}
        >
          <strong className="text-focus">{s.version}</strong>
        </a>{" "}
        is available.
      </>
    );
  } else {
    status = "Check for a new version of LiteCode.";
  }
  return (
    <>
      <Dialog.Root
        open={s.open}
        onOpenChange={(open) => {
          if (!working.current && !busy) {
            useUpdates.setState({ open });
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop fixed inset-0 bg-backdrop z-[150]" />
          <Dialog.Popup
            className={`modal-panel fixed top-[50%] left-[50%] bg-widget border border-strong rounded-[6px] w-120 max-w-[90vw] p-6 z-[151] ${workbenchStyles["modal-panel"]} update-panel w-140 max-h-[85vh] overflow-y-auto ${updateDialogStyles["update-panel"]}`}
          >
            <Dialog.Title>LiteCode Updates</Dialog.Title>
            <Dialog.Description className="flex flex-wrap items-baseline gap-x-4 gap-y-1 select-text">
              <span>
                {s.currentVersion ? `Current version: ${s.currentVersion}` : "Application updates"}
              </span>
              {s.version && <Icon name="arrow-right" className="text-muted self-center" />}
              <span role="status" aria-live="polite">
                {status}
              </span>
            </Dialog.Description>
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
                {s.open && (
                  <Suspense fallback={<p role="status">Loading release notes…</p>}>
                    <div className="select-text">
                      <UpdateReleaseNotes notes={s.notes} openLink={openLink} />
                    </div>
                  </Suspense>
                )}
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
            <div className="flex justify-end flex-wrap gap-2 mt-5">
              {s.version && (
                <button
                  className={`${actionButtonClass} primary bg-focus text-foreground-strong rounded-[2px] py-[5px] px-[14px] ${workbenchStyles["primary"]}`}
                  disabled={busy}
                  onClick={() => (s.portable ? openLink(releaseUrl) : void install())}
                >
                  {busy && <Icon name="loading" className="animate-spin" />}
                  {installLabel(s.phase, s.portable, busy)}
                </button>
              )}
              <Dialog.Close className={actionButtonClass} disabled={busy}>
                Close
              </Dialog.Close>
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
