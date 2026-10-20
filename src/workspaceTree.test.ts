import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeSnapshot } from './types';

vi.mock('./bridge', () => ({ call: vi.fn(), errorMessage: (e: Error) => e.message }));
import { call } from './bridge';
import { useApp, setApp } from './store';
import { refreshTree } from './workspaceTree';

const snapshot = (path: string): TreeSnapshot => ({ paths: [path], git: [{ path, status: 'ignored' }], branch: null, warnings: [], truncated: false });
function deferred() {
  let resolve!: (value: TreeSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TreeSnapshot>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.clearAllMocks(); setApp({ root: null, treeRoot: null, notice: null }); });

describe('Workspace scan scheduling', () => {
  it('coalesces changes during a scan into a follow-up and waits for its final snapshot', async () => {
    setApp({ root: 'C:/project' });
    const first = deferred(); const second = deferred();
    vi.mocked(call).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const running = refreshTree();
    expect(refreshTree()).toBe(running);
    expect(refreshTree()).toBe(running);
    expect(call).toHaveBeenCalledTimes(1);
    first.resolve(snapshot('old.txt'));
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(2);
    second.resolve(snapshot('new.txt'));
    await running;
    expect(useApp.getState().tree.git).toEqual([{ path: 'new.txt', status: 'ignored' }]);
    expect(useApp.getState().treeRoot).toBe('C:/project');
  });

  it('also handles changes during the follow-up scan', async () => {
    setApp({ root: 'C:/project' });
    const first = deferred(); const second = deferred(); const third = deferred();
    vi.mocked(call).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const running = refreshTree(); refreshTree();
    first.resolve(snapshot('first.txt')); await Promise.resolve();
    refreshTree(); second.resolve(snapshot('second.txt')); await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(3);
    third.resolve(snapshot('third.txt')); await running;
    expect(useApp.getState().tree.paths).toEqual(['third.txt']);
  });

  it('discards old workspace results and pending work when switching folders', async () => {
    setApp({ root: 'C:/old' });
    const old = deferred(); const current = deferred();
    vi.mocked(call).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldScan = refreshTree(); refreshTree();
    setApp({ root: 'C:/new' }); const newScan = refreshTree();
    current.resolve(snapshot('new.txt')); await newScan;
    old.resolve(snapshot('old.txt')); await oldScan;
    expect(call).toHaveBeenCalledTimes(2);
    expect(useApp.getState().treeRoot).toBe('C:/new');
    expect(useApp.getState().tree.paths).toEqual(['new.txt']);
  });

  it('releases failed scans and retries a pending change', async () => {
    setApp({ root: 'C:/project' });
    const first = deferred();
    vi.mocked(call).mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot('new.txt'));
    const running = refreshTree(); refreshTree();
    first.reject(new Error('scan failed')); await running;
    expect(useApp.getState().notice).toBe('scan failed');
    expect(useApp.getState().tree.paths).toEqual(['new.txt']);
    vi.mocked(call).mockResolvedValueOnce(snapshot('latest.txt'));
    await refreshTree();
    expect(useApp.getState().tree.paths).toEqual(['latest.txt']);
  });

  it('does not start a scan without a workspace', async () => {
    setApp({ root: null }); await refreshTree();
    expect(call).not.toHaveBeenCalled();
  });
});
