// Adapt a fixture's path list to the application's directory and Git IPC contracts.
export const workspaceFixtureCommands = String.raw`
  if (command === 'read_workspace_directory' || command === 'workspace_git_status') {
    const snapshot = await call('fixture_workspace_snapshot', args);
    if (command === 'workspace_git_status') return { root: args.expectedRoot, session: 1, git: snapshot.git, branch: snapshot.branch, warnings: snapshot.warnings };
    const prefix = args.directory ? args.directory.replace(/\/$/, '') + '/' : '';
    const children = new Set();
    for (const path of snapshot.paths) {
      if (!path.startsWith(prefix) || path === prefix) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      children.add(prefix + (slash < 0 ? rest : rest.slice(0, slash + 1)));
    }
    return { root: args.expectedRoot, session: 1, directory: args.directory, paths: [...children], warnings: snapshot.warnings };
  }
`;
