import welcomeStyles from "./WelcomePage.module.css";
import { errorMessage } from "../core/bridge";
import { execute, openFolder } from "../core/commands";
import { basename, visiblePath } from "../editor/documents";
import { notify, useApp } from "../store/store";
import { Icon } from "./ui";

const startActions = [
  { label: "New File…", icon: "new-file", command: "workbench.action.files.newUntitledFile" },
  { label: "Open File…", icon: "go-to-file", command: "workbench.action.files.openFile" },
  { label: "Open Folder…", icon: "folder-opened", command: "workbench.action.files.openFolder" },
];

export function WelcomePage() {
  const recent = useApp((s) => s.recent);
  return (
    <section
      className={`welcome-page absolute inset-0 overflow-auto p-[clamp(24px,_5vw,_56px)] bg-editor ${welcomeStyles["welcome-page"]}`}
      aria-labelledby="welcome-title"
    >
      <div className="welcome-content w-full max-w-220">
        <header className={`welcome-heading mb-9 ${welcomeStyles["welcome-heading"]}`}>
          <h1 id="welcome-title">LiteCode</h1>
          <p>Editing evolved</p>
        </header>
        <section
          className={`welcome-section ${welcomeStyles["welcome-section"]}`}
          aria-labelledby="welcome-start"
        >
          <h2 id="welcome-start">Start</h2>
          <ul className={`welcome-actions list-none p-0 m-0 ${welcomeStyles["welcome-actions"]}`}>
            {startActions.map((action) => (
              <li key={action.command}>
                <button
                  type="button"
                  className={`welcome-action flex items-center gap-3 max-w-full py-1 px-0 text-[20px] leading-[28px] text-left rounded-[2px] ${welcomeStyles["welcome-action"]}`}
                  onClick={() => void execute(action.command)}
                >
                  <Icon name={action.icon} />
                  <span>{action.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section
          className={`welcome-section ${welcomeStyles["welcome-section"]}`}
          aria-labelledby="welcome-recent"
        >
          <h2 id="welcome-recent">Recent</h2>
          {recent.length ? (
            <ul className="welcome-recents list-none p-0 m-0">
              {recent.slice(0, 5).map((path) => {
                const displayPath = visiblePath(path).replace(/[\\/]+$/, "");
                const parent = displayPath.slice(
                  0,
                  Math.max(displayPath.lastIndexOf("/"), displayPath.lastIndexOf("\\")) + 1,
                );
                return (
                  <li key={path}>
                    <button
                      type="button"
                      className={`welcome-recent flex items-baseline gap-5 max-w-full py-1 px-0 text-[18px] leading-[26px] text-left rounded-[2px] ${welcomeStyles["welcome-recent"]}`}
                      title={visiblePath(path)}
                      onClick={() =>
                        void openFolder(false, path).catch((e) => notify(errorMessage(e)))
                      }
                    >
                      <span
                        className={`welcome-recent-name shrink-0 max-w-[50%] overflow-hidden text-ellipsis whitespace-nowrap ${welcomeStyles["welcome-recent-name"]}`}
                      >
                        {basename(displayPath)}
                      </span>
                      <span className="welcome-recent-path text-inherit min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {parent}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p
              className={`welcome-no-recents text-[16px] m-0 leading-[26px] ${welcomeStyles["welcome-no-recents"]}`}
            >
              No recent folders
            </p>
          )}
          {recent.length > 5 && (
            <button
              type="button"
              className={`welcome-more text-[18px] leading-[26px] py-1 px-0 rounded-[2px] ${welcomeStyles["welcome-more"]}`}
              onClick={() => void execute("workbench.action.openRecent")}
            >
              More…
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
