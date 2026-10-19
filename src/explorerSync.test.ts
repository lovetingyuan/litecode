import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '@pierre/trees'
import { createExplorerSync } from './explorerSync'

const cleanups: (() => void)[] = []
function fixture(paths: string[]) {
  const model = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false })
  const sync = createExplorerSync(model)
  sync.reset(paths)
  cleanups.push(() => { sync.dispose(); model.cleanUp() })
  const directory = (path: string) => {
    const item = model.getItem(path)
    if (!item || !('expand' in item)) throw new Error(`Missing directory: ${path}`)
    return item
  }
  return { model, sync, directory }
}
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

describe('Explorer snapshot reconciliation', () => {
  it('keeps expansion, hidden child expansion, selection and focus through additions and removals', () => {
    const { model, sync, directory } = fixture(['alpha/deep/a.txt', 'beta/deep/b.txt'])
    directory('alpha/deep/').expand()
    directory('alpha/').collapse()
    directory('beta/deep/').expand()
    model.getItem('beta/deep/b.txt')!.select()
    model.focusPath('beta/deep/b.txt')
    const observations: boolean[][] = []
    model.subscribe(() => observations.push(['alpha/', 'alpha/deep/', 'beta/', 'beta/deep/'].map(p => directory(p).isExpanded())))
    sync.update(['alpha/deep/new.txt', 'beta/deep/b.txt', 'beta/new.txt', 'new/child.txt'])
    expect(observations).toEqual([[false, true, true, true]])
    expect(model.getSelectedPaths()).toEqual(['beta/deep/b.txt'])
    expect(model.getFocusedPath()).toBe('beta/deep/b.txt')
    expect(directory('new/').isExpanded()).toBe(false)
    directory('alpha/').expand()
    expect(directory('alpha/deep/').isExpanded()).toBe(true)
  })

  it('does not mutate the tree for an identical path set or reordered input', () => {
    const { model, sync } = fixture(['a.txt', 'dir/b.txt'])
    const mutation = vi.fn()
    model.onMutation('*', mutation)
    sync.update(['dir/b.txt', 'a.txt'])
    expect(mutation).not.toHaveBeenCalled()
  })

  it('retains an expanded directory when its last file is deleted, and removes whole subtrees once', () => {
    const { model, sync, directory } = fixture(['keep/last.txt', 'delete/deep/a.txt', 'delete/b.txt'])
    directory('keep/').expand()
    const mutation = vi.fn()
    model.onMutation('*', mutation)
    sync.update(['keep/'])
    expect(directory('keep/').isExpanded()).toBe(true)
    expect(model.getItem('delete/')).toBeNull()
    expect(model.getItem('keep/last.txt')).toBeNull()
    const event = mutation.mock.calls[0][0]
    expect(event.operation).toBe('batch')
    expect(event.events.map((e: { operation: string; path: string }) => [e.operation, e.path])).toEqual([
      ['remove', 'delete/'], ['remove', 'keep/last.txt'],
    ])
  })

  it('replaces files with directories and directories with files without disturbing siblings', () => {
    const { model, sync, directory } = fixture(['entry', 'other/deep/a.txt', 'stable/a.txt'])
    directory('stable/').expand()
    sync.update(['entry/child.txt', 'other', 'stable/a.txt'])
    expect(model.getItem('entry/')!.isDirectory()).toBe(true)
    expect(model.getItem('entry/child.txt')).not.toBeNull()
    expect(model.getItem('other')!.isDirectory()).toBe(false)
    expect(model.getVisibleRows(0, 99).map(row => row.path)).not.toContain('other/deep/')
    expect(directory('stable/').isExpanded()).toBe(true)
    sync.update(['entry', 'other/empty/', 'stable/a.txt'])
    expect(model.getItem('entry')!.isDirectory()).toBe(false)
    expect(directory('other/empty/').isExpanded()).toBe(false)
  })

  it('tracks optimistic rename and drag batches before the next scan, including rollback', () => {
    const { model, sync, directory } = fixture(['src/deep/a.txt', 'destination/', 'stay/a.txt'])
    directory('src/deep/').expand()
    model.move('src/', 'renamed/')
    model.batch([{ type: 'move', from: 'renamed/deep/', to: 'destination/deep/' }])
    sync.update(['renamed/', 'destination/deep/a.txt', 'stay/a.txt'])
    expect(directory('destination/deep/').isExpanded()).toBe(true)
    expect(model.getItem('src/')).toBeNull()
    expect(model.getItem('renamed/deep/')).toBeNull()
    sync.update(['src/deep/a.txt', 'destination/', 'stay/a.txt'])
    expect(model.getItem('destination/deep/')).toBeNull()
    expect(model.getItem('src/deep/a.txt')).not.toBeNull()
    expect(model.getItem('renamed/')).toBeNull()
  })

  it('restores a removed implicit parent even when the leaf path remains in both snapshots', () => {
    const { model, sync } = fixture(['dir/a.txt'])
    model.remove('dir/', { recursive: true })
    sync.update(['dir/a.txt'])
    expect(model.getItem('dir/a.txt')).not.toBeNull()
  })

  it('tracks optimistic moves that replace another subtree', () => {
    const { model, sync } = fixture(['source/a.txt', 'target/old/b.txt'])
    model.move('source/', 'target/', { collision: 'replace' })
    sync.update(['target/a.txt'])
    expect(model.getItem('target/a.txt')).not.toBeNull()
    expect(model.getItem('target/old/')).toBeNull()
  })

  it('resets expansion only when initializing another workspace', () => {
    const { model, sync, directory } = fixture(['same/a.txt', 'old/a.txt'])
    directory('same/').expand()
    sync.reset(['same/b.txt', 'new/'])
    expect(directory('same/').isExpanded()).toBe(false)
    expect(model.getItem('old/')).toBeNull()
    sync.update(['same/b.txt', 'new/c.txt'])
    expect(model.getItem('new/c.txt')).not.toBeNull()
  })
})
