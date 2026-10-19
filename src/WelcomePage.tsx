import { errorMessage } from './bridge';
import { execute, openFolder } from './commands';
import { basename, visiblePath } from './documents';
import { notify, useApp } from './store';
import { Icon } from './ui';

const startActions = [
  { label: 'New File…', icon: 'new-file', command: 'workbench.action.files.newUntitledFile' },
  { label: 'Open File…', icon: 'go-to-file', command: 'workbench.action.files.openFile' },
  { label: 'Open Folder…', icon: 'folder-opened', command: 'workbench.action.files.openFolder' },
];

export function WelcomePage() {
  const recent = useApp(s => s.recent);
  return <section className="welcome-page" aria-labelledby="welcome-title">
    <div className="welcome-content">
      <header className="welcome-heading">
        <h1 id="welcome-title">LiteCode</h1>
        <p>Editing evolved</p>
      </header>
      <section className="welcome-section" aria-labelledby="welcome-start">
        <h2 id="welcome-start">Start</h2>
        <ul className="welcome-actions">
          {startActions.map(action => <li key={action.command}>
            <button type="button" className="welcome-action" onClick={() => void execute(action.command)}>
              <Icon name={action.icon} /><span>{action.label}</span>
            </button>
          </li>)}
        </ul>
      </section>
      <section className="welcome-section" aria-labelledby="welcome-recent">
        <h2 id="welcome-recent">Recent</h2>
        {recent.length ? <ul className="welcome-recents">
          {recent.slice(0, 5).map(path => {
            const displayPath = visiblePath(path).replace(/[\\/]+$/, '');
            const parent = displayPath.slice(0, Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\')) + 1);
            return <li key={path}>
              <button type="button" className="welcome-recent" title={visiblePath(path)} onClick={() => void openFolder(false, path).catch(e => notify(errorMessage(e)))}>
                <span className="welcome-recent-name">{basename(displayPath)}</span>
                <span className="welcome-recent-path">{parent}</span>
              </button>
            </li>;
          })}
        </ul> : <p className="welcome-no-recents">No recent folders</p>}
        {recent.length > 5 && <button type="button" className="welcome-more" onClick={() => void execute('workbench.action.openRecent')}>More…</button>}
      </section>
    </div>
  </section>;
}
