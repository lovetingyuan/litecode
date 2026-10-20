import { useEffect, useRef, useState } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import {
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type ContextMenuItem as FileTreeContextMenuItem,
  type ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  type FileTreeDropContext,
} from '@pierre/trees'
import { Menu } from '@base-ui/react/menu'
import PrepareWorker from './tree.worker?worker'
import { useApp, setApp, notify } from './store'
import { call, errorMessage, desktop } from './bridge'
import {
  basename,
  join,
  openPath,
  relative,
  renameDocumentPaths,
  renameDocuments,
  beginDocumentMove,
  normalize,
  pathTitle,
  visiblePath,
} from './documents'
import { ask, input } from './dialog'
import { Icon, IconButton } from './ui'
import type { TreeSnapshot } from './types'
import { createExplorerSync } from './explorerSync'
import { treeMovePlan, type FileMove, type MoveReport } from './explorerMove'

let clipboard: { paths: string[]; cut: boolean } | null = null
const scans = new Map<string, Promise<void>>()
export function refreshTree() {
  const root = useApp.getState().root
  if (!root) return Promise.resolve()
  const previous = scans.get(root)
  if (previous) return previous
  const current = call<TreeSnapshot>('scan_workspace')
    .then(tree => {
      if (useApp.getState().root === root) setApp({ tree, treeRoot: root })
    })
    .catch(e => {
      if (useApp.getState().root === root) notify(errorMessage(e))
    })
    .finally(() => {
      scans.delete(root)
    })
  scans.set(root, current)
  return current
}
export function revealInTree(path: string) {
  setApp({ sidebar: 'explorer' })
  window.dispatchEvent(new CustomEvent('reveal-tree', { detail: path }))
}

export function Explorer({ openFolder }: { openFolder: () => void }) {
  const root = useApp(s => s.root)
  const tree = useApp(s => s.tree)
  const treeRoot = useApp(s => s.treeRoot)
  const groups = useApp(s => s.groups)
  const docs = useApp(s => s.docs)
  const activeGroup = useApp(s => s.activeGroup)
  const sidebar = useApp(s => s.sidebar)
  const tabRevealRequest = useApp(s => s.tabRevealRequests[s.activeGroup] ?? 0)
  const [context, setContext] = useState<{
    item: FileTreeContextMenuItem
    context: FileTreeContextMenuOpenContext
  } | null>(null)
  const worker = useRef<Worker | null>(null)
  const generation = useRef(0)
  const [prepared, setPrepared] = useState<{ id: number; root: string | null; paths: string[] }>({ id: 0, root: null, paths: [] })
  const explicitReveal = useRef<{
    path: string; group: string; activePath: string | null | undefined; request: number
  } | null>(null)
  const [explicitRequest, setExplicitRequest] = useState(0)
  const operationQueue = useRef(Promise.resolve())
  const [expanded, setExpanded] = useState(true)
  const wasExpanded = useRef(expanded)
  const revealPending = useRef(true)
  const moveBusy = useRef(false)
  const moveExecuting = useRef(false)
  const moveAbort = useRef<AbortController | null>(null)
  const draggedPaths = useRef<readonly string[]>([])
  const pendingMoveSelection = useRef<string[] | null>(null)
  const [rootDropTarget, setRootDropTarget] = useState(false)
  const { model } = useFileTree({
    preparedInput: preparePresortedFileTreeInput([]),
    flattenEmptyDirectories: false,
    initialExpansion: 0,
    itemHeight: 26,
    overscan: 10,
    icons: { set: 'complete', colored: true },
    search: false,
    unsafeCSS: `
      svg[data-icon-name]{width:var(--trees-icon-width);height:var(--trees-icon-width)}
      [data-item-section="git"] [data-icon-name="file-tree-icon-dot"]{transform:none}
      [data-file-tree-root-drag-target="true"] > [data-file-tree-virtualized-scroll]{outline:1px solid #0078d4;outline-offset:-1px;background:#04395e44}
      /* Keep each level at 14px and its guide centered under the parent icon. */
      [data-item-section="spacing"]{padding-left:0;margin-right:calc(-1 * var(--trees-item-row-gap))}
      [data-item-section="spacing"] > [data-item-section="spacing-item"]{
        width:14px;box-sizing:border-box;flex-shrink:0;margin:0;
        transform:translateX(calc(var(--trees-icon-width) / 2 - .5px));
      }
    `,
    renaming: { onRename: e => mutate(e.sourcePath, e.destinationPath), onError: notify },
    dragAndDrop: {
      canDrag: paths => {
        if (moveBusy.current || !rootRef.current) return false
        draggedPaths.current = paths
        return true
      },
      canDrop: e => !moveBusy.current && !!treeMovePlan(e.draggedPaths, e.target.directoryPath)?.length,
      onDropRequest: e => { void requestMove(e) },
      onDropError: notify,
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'right-click',
        onOpen: (item, context) => setContext({ item, context }),
        onClose: () => setContext(null),
      },
    },
  })
  const rootRef = useRef(root)
  rootRef.current = root
  async function requestMove(event: FileTreeDropContext) {
    const base = rootRef.current
    const planned = treeMovePlan(event.draggedPaths, event.target.directoryPath)
    if (!base || moveBusy.current || !planned?.length) return
    moveBusy.current = true
    const abort = new AbortController()
    moveAbort.current = abort
    const focused = model.getFocusedPath()
    let releaseDocuments: (() => void) | undefined
    try {
      await operationQueue.current
      if (abort.signal.aborted) return
      const args = {
        sources: planned.map(p => join(base, p.from)),
        targetDirectory: event.target.directoryPath ? join(base, event.target.directoryPath) : base,
        expectedRoot: base,
      }
      const moves = await call<FileMove[]>('plan_file_moves', args)
      if (abort.signal.aborted || !moves.length) return
      const names = moves.map(move => basename(move.from))
      const destination = event.target.directoryPath?.replace(/\/$/, '') || basename(base)
      const choice = await ask(
        `Are you sure you want to move ${moves.length === 1 ? `'${names[0]}'` : `the following ${moves.length} files and folders`} into '${destination}'?`,
        '', ['Move', 'Cancel'], {
          items: moves.map((move, index) => names.filter(name => name === names[index]).length > 1 ? relative(move.from, base) : names[index]),
          signal: abort.signal,
        },
      )
      if (choice !== 'Move' || abort.signal.aborted) return
      moveExecuting.current = true
      releaseDocuments = await beginDocumentMove(moves.map(move => move.from))
      if (abort.signal.aborted) return
      const report = await call<MoveReport>('move_files', args)
      // Always rebind successful disk moves, including a partially failed batch.
      await renameDocuments(report.moved)
      if (!abort.signal.aborted && report.moved.length) {
        const operations = report.moved.map(move => {
          const from = relative(move.from, base)
          const directory = model.getItem(from)?.isDirectory() ?? planned.some(p => p.from === from + '/')
          return { type: 'move' as const, from: from + (directory ? '/' : ''), to: relative(move.to, base) + (directory ? '/' : '') }
        })
        pendingMoveSelection.current = operations.map(op => op.to)
        model.batch(operations)
        revealPending.current = false
      }
      if (report.failed.length) notify(`Moved ${report.moved.length} item(s). The remaining items were not moved.\n${report.failed.map(f => `${relative(f.path, base)}: ${f.message}`).join('\n')}`)
    } catch (e) {
      if (!abort.signal.aborted) notify(errorMessage(e))
    } finally {
      releaseDocuments?.()
      const executed = moveExecuting.current
      moveExecuting.current = false
      try {
        if (executed) {
          // Finish a watcher scan that may have started before the move, then scan again.
          await scans.get(rootRef.current ?? base)
          await refreshTree()
        } else if (!abort.signal.aborted && focused) {
          model.focusPath(focused)
          model.getFileTreeContainer()?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
        }
      } finally {
        moveBusy.current = false
        if (moveAbort.current === abort) moveAbort.current = null
      }
    }
  }
  function openTreeFile(event: Event, pinned = false) {
    // Rows live in the tree's shadow DOM; ignore rename inputs and empty space.
    const targets = event.composedPath()
    if (targets.some(target => target instanceof HTMLInputElement)) return false
    const row = targets.find(
      target => target instanceof HTMLElement && target.hasAttribute('data-item-path'),
    ) as HTMLElement | undefined
    const path = row?.dataset.itemPath
    const item = path ? model.getItem(path) : null
    if (!path || !item || item.isDirectory() || !rootRef.current) return false
    void openPath(join(rootRef.current, path), { pinned, preserveFocus: !pinned }).catch(e =>
      notify(errorMessage(e)),
    )
    return true
  }
  function mutate(from: string, to: string) {
    const root = rootRef.current
    if (!root) return
    operationQueue.current = operationQueue.current.then(async () => {
      try {
        await call('file_operation', {
          operation: { kind: 'rename', path: join(root, from), destination: join(root, to) },
        })
        await renameDocumentPaths(join(root, from), join(root, to))
      } catch (e) {
        notify(errorMessage(e))
      }
      await refreshTree()
    })
  }
  useEffect(() => {
    const sync = createExplorerSync(model)
    const w = new PrepareWorker()
    worker.current = w
    let appliedRoot: string | null = null
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.root !== previous.root) {
        moveAbort.current?.abort()
        draggedPaths.current = []
        pendingMoveSelection.current = null
        setRootDropTarget(false)
        ++generation.current
        sync.reset([])
        appliedRoot = null
      }
    })
    w.onmessage = (event: MessageEvent<{ id: number; root: string; paths: string[] }>) => {
      if (moveExecuting.current) return
      const state = useApp.getState()
      if (event.data.id === generation.current && event.data.root === state.root && state.treeRoot === state.root) {
        if (appliedRoot !== event.data.root) sync.reset(event.data.paths)
        else sync.update(event.data.paths)
        appliedRoot = event.data.root
        const moved = pendingMoveSelection.current
        if (moved) {
          pendingMoveSelection.current = null
          revealPending.current = false
          for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect()
          for (const path of moved) {
            const parts = path.replace(/\/$/, '').split('/')
            for (let depth = 1; depth < parts.length; depth++) {
              const parent = model.getItem(parts.slice(0, depth).join('/'))
              if (parent && 'expand' in parent) parent.expand()
            }
            model.getItem(path)?.select()
          }
          model.focusPath(moved[0])
          model.scrollToPath(moved[0], { focus: false, offset: 'nearest' })
        }
        setPrepared(event.data)
      }
    }
    return () => {
      moveAbort.current?.abort()
      w.terminate()
      unsubscribe()
      sync.dispose()
      worker.current = null
    }
  }, [model])
  useEffect(() => {
    if (root && treeRoot === root)
      worker.current?.postMessage({ id: ++generation.current, root, paths: tree.paths })
  }, [tree.paths, root, treeRoot])
  useEffect(() => {
    model.setGitStatus(
      tree.git.map(g => ({ ...g, status: g.status === 'conflicted' ? 'modified' : g.status })),
    )
  }, [model, tree.git])
  useEffect(() => {
    const onReveal = (e: Event) => {
      const state = useApp.getState()
      explicitReveal.current = {
        path: (e as CustomEvent<string>).detail,
        group: state.activeGroup,
        activePath: state.docs[state.groups.find(g => g.id === state.activeGroup)?.active ?? '']?.path,
        request: state.tabRevealRequests[state.activeGroup] ?? 0,
      }
      setExplicitRequest(request => request + 1)
    }
    window.addEventListener('reveal-tree', onReveal)
    return () => window.removeEventListener('reveal-tree', onReveal)
  }, [])
  const active = docs[groups.find(g => g.id === activeGroup)?.active ?? '']
  useEffect(() => {
    if (!moveExecuting.current && !pendingMoveSelection.current) revealPending.current = true
  }, [activeGroup, active?.path, tabRevealRequest, root, sidebar])
  useEffect(() => {
    if (moveExecuting.current || pendingMoveSelection.current) return
    // A newer editor activation supersedes an explicit reveal waiting for tree data.
    const pending = explicitReveal.current
    if (pending && (pending.group !== activeGroup || pending.activePath !== active?.path || pending.request !== tabRevealRequest))
      explicitReveal.current = null
    // Collapsing the workspace is a user action, not a request to reveal again.
    const collapsed = wasExpanded.current && !expanded
    const reopened = !wasExpanded.current && expanded
    wasExpanded.current = expanded
    if (collapsed) revealPending.current = false
    if (reopened) revealPending.current = true
    if ((collapsed && !explicitReveal.current) || sidebar !== 'explorer') return
    if (!revealPending.current && !explicitReveal.current) return
    if (prepared.id !== generation.current || prepared.root !== root || treeRoot !== root) return
    const focus = explicitReveal.current !== null
    const path = explicitReveal.current?.path ?? active?.path
    const base = root ? visiblePath(root).replace(/[\\/]+$/, '') : null
    if (!path || !base || !normalize(visiblePath(path)).startsWith(normalize(base) + '/')) {
      explicitReveal.current = null
      revealPending.current = false
      return
    }
    const requestedPath = relative(path, base)
    // Keep the tree's canonical casing even if a file was opened through another spelling.
    const canonicalPath = prepared.paths.includes(requestedPath) ? requestedPath
      : prepared.paths.find(p => normalize(p) === normalize(requestedPath))
    const item = canonicalPath ? model.getItem(canonicalPath) : null
    // A newly opened file can precede the scan that first includes it.
    if (!item) return
    if (item.isDirectory()) {
      explicitReveal.current = null
      revealPending.current = false
      return
    }
    if (!expanded) {
      setExpanded(true)
      return
    }
    const target = item.getPath()
    // Keep pointer/keyboard navigation in the tree stable; editor navigation reveals context.
    const navigatingTree = !focus && document.activeElement === model.getFileTreeContainer()
      && model.getFocusedPath() === target
    const parts = target.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = model.getItem(parts.slice(0, depth).join('/'))
      if (parent && 'expand' in parent) parent.expand()
    }
    for (const selected of model.getSelectedPaths()) {
      if (selected !== target) model.getItem(selected)?.deselect()
    }
    item.select()
    model.focusPath(target)
    model.scrollToPath(target, { focus: false, offset: navigatingTree ? 'nearest' : 'center' })
    explicitReveal.current = null
    revealPending.current = false
    if (focus) {
      // Automatic reveals retain DOM focus; explicit reveals transfer it after rendering.
      const frame = requestAnimationFrame(() => {
        model.getFileTreeContainer()?.shadowRoot
          ?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(target)}"]`)
          ?.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [model, activeGroup, active?.path, tabRevealRequest, root, treeRoot, sidebar, prepared, expanded, explicitRequest])

  async function action(kind: string, path = model.getFocusedPath() ?? '') {
    if (!root) return
    const handle = model.getItem(path)
    const selected = model.getSelectedPaths()
    const paths = selected.includes(path) ? [...selected] : [path]
    const full = join(root, path)
    context?.context.close({ restoreFocus: kind !== 'rename' })
    setContext(null)
    try {
      if (kind === 'rename') {
        model.startRenaming(path)
        return
      }
      if (kind === 'copy' || kind === 'cut') {
        clipboard = { paths: paths.map(p => join(root, p)), cut: kind === 'cut' }
        return
      }
      if (kind === 'fullPath' || kind === 'relativePath') {
        const text = paths
          .map(p => (kind === 'fullPath' ? join(root, p).replace(/\//g, '\\') : p))
          .join('\r\n')
        if (desktop) await (await import('@tauri-apps/plugin-clipboard-manager')).writeText(text)
        else await navigator.clipboard.writeText(text)
        return
      }
      if (kind === 'reveal') {
        await call('reveal_path', { path: full })
        return
      }
      if (kind === 'newFile' || kind === 'newFolder') {
        const name = await input(kind === 'newFile' ? 'New File' : 'New Folder')
        if (!name) return
        const parent = handle?.isDirectory()
          ? path.replace(/\/$/, '')
          : path.split('/').slice(0, -1).join('/')
        const target = join(root, parent ? `${parent}/${name}` : name)
        await call('file_operation', { operation: { kind, path: target } })
        if (kind === 'newFile') await openPath(target, { pinned: true })
      }
      if (kind === 'delete') {
        if (
          (await ask('Move to Recycle Bin?', paths.join('\n'), [
            'Move to Recycle Bin',
            'Cancel',
          ])) !== 'Move to Recycle Bin'
        )
          return
        const filtered = paths.filter(
          p => !paths.some(parent => parent !== p && p.startsWith(parent.replace(/\/$/, '') + '/')),
        )
        for (const path of filtered)
          await call('file_operation', { operation: { kind: 'delete', path: join(root, path) } })
      }
      if (kind === 'paste' && clipboard) {
        const parent = handle?.isDirectory() ? full : full.slice(0, full.lastIndexOf('/'))
        for (const source of clipboard.paths) {
          const target = join(parent, basename(source))
          await call('file_operation', {
            operation: {
              kind: clipboard.cut ? 'rename' : 'copy',
              path: source,
              destination: target,
            },
          })
          if (clipboard.cut) await renameDocumentPaths(source, target)
        }
        if (clipboard.cut) clipboard = null
      }
      await refreshTree()
    } catch (e) {
      notify(errorMessage(e))
      await refreshTree()
    }
  }
  const treeStyle = {
    flex: 1,
    minHeight: 0,
    // Included in the virtual layout by tools/patch-trees-scroll.mjs.
    '--trees-scroll-padding-bottom': '32px',
    ...themeToTreeStyles({
      colors: {
        'sideBar.background': '#181818',
        'sideBar.foreground': '#cccccc',
        'list.activeSelectionBackground': '#04395e',
        'list.activeSelectionForeground': '#ffffff',
        'list.inactiveSelectionBackground': '#37373d',
        'list.hoverBackground': '#2a2d2e',
        focusBorder: '#0078d4',
        'gitDecoration.modifiedResourceForeground': '#e2c08d',
        'gitDecoration.untrackedResourceForeground': '#73c991',
      },
    }),
    '--trees-font-family-override': '"Segoe UI", sans-serif',
    '--trees-font-size-override': '15px',
    '--trees-icon-width-override': '18px',
    '--trees-item-row-gap-override': '5px',
    '--trees-padding-inline-override': '0px',
  }
  return (
    <section className="explorer view" aria-label="Explorer">
      <div className="view-title">
        <span>EXPLORER</span>
        <div className="actions">
          <IconButton
            icon="search"
            label="Search (Ctrl+Shift+F)"
            onClick={() => setApp({ sidebar: 'search' })}
          />
          <IconButton icon="ellipsis" label="Explorer actions" onClick={() => model.openSearch()} />
        </div>
      </div>
      {!root ? (
        <div className="empty-sidebar">
          <p>You have not yet opened a folder.</p>
          <button className="primary" onClick={openFolder}>
            Open Folder
          </button>
          <p className="muted">Opening a folder enables file browsing and workspace search.</p>
        </div>
      ) : (
        <>
          <div className="section-heading" data-drop-target={rootDropTarget}
            onDragOver={e => {
              if (!draggedPaths.current.length || moveBusy.current) return
              e.preventDefault()
              const allowed = !!treeMovePlan(draggedPaths.current, null)?.length
              e.dataTransfer.dropEffect = allowed ? 'move' : 'none'
              setRootDropTarget(allowed)
            }}
            onDragLeave={() => setRootDropTarget(false)}
            onDrop={e => {
              e.preventDefault()
              setRootDropTarget(false)
              if (draggedPaths.current.length) void requestMove({ draggedPaths: draggedPaths.current, target: { kind: 'root', directoryPath: null, hoveredPath: null, flattenedSegmentPath: null } })
              draggedPaths.current = []
            }}
          >
            <button title={pathTitle(root)} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
              {basename(root).toUpperCase()}
            </button>
            <div className="actions">
              <IconButton icon="new-file" label="New File" onClick={() => void action('newFile')} />
              <IconButton
                icon="new-folder"
                label="New Folder"
                onClick={() => void action('newFolder')}
              />
              <IconButton
                icon="refresh"
                label="Refresh Explorer"
                onClick={() => void refreshTree()}
              />
              <IconButton
                icon="collapse-all"
                label="Collapse Folders"
                onClick={() =>
                  tree.paths
                    .filter(p => p.endsWith('/'))
                    .forEach(p => {
                      const i = model.getItem(p.slice(0, -1))
                      if (i && 'collapse' in i) i.collapse()
                    })
                }
              />
            </div>
          </div>
          {expanded && (
            <FileTree
              model={model}
              className="file-tree"
              style={treeStyle}
              onDragEnd={() => { draggedPaths.current = []; setRootDropTarget(false) }}
              onPointerMove={e => {
                // Tree rows are virtualized inside a shadow root; resolve the current row on hover.
                const row = e.nativeEvent.composedPath().find(
                  target => target instanceof HTMLElement && target.hasAttribute('data-item-path'),
                ) as HTMLElement | undefined
                if (row?.dataset.itemPath) row.title = pathTitle(join(root, row.dataset.itemPath))
              }}
              onClick={e => {
                if (e.detail === 2 || e.ctrlKey || e.metaKey || e.shiftKey) return
                if (e.detail !== 0 && useApp.getState().settings['workbench.list.openMode'] === 'doubleClick') return
                openTreeFile(e.nativeEvent)
              }}
              onDoubleClick={e => { openTreeFile(e.nativeEvent, true) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && openTreeFile(e.nativeEvent, true)) {
                  e.preventDefault()
                } else if (e.key === 'F2') {
                  e.preventDefault()
                  model.startRenaming()
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  void action('delete')
                } else if (e.ctrlKey && ['c', 'x', 'v'].includes(e.key.toLowerCase())) {
                  e.preventDefault()
                  void action(
                    ({ c: 'copy', x: 'cut', v: 'paste' } as Record<string, string>)[
                      e.key.toLowerCase()
                    ],
                  )
                }
              }}
            />
          )}
          {tree.truncated && (
            <p className="inline-warning">Explorer index reached 200,000 entries.</p>
          )}
          {tree.warnings.length > 0 && (
            <button className="inline-warning" onClick={() => notify(tree.warnings.join('\n'))}>
              {tree.warnings.length} scan warning(s)
            </button>
          )}
        </>
      )}
      <Menu.Root
        open={!!context}
        onOpenChange={open => {
          if (!open) {
            context?.context.close()
            setContext(null)
          }
        }}
      >
        <Menu.Portal>
          <Menu.Positioner
            className="z-90"
            anchor={context?.context.anchorElement}
            side="right"
            align="start"
          >
            <Menu.Popup className="context-menu" data-file-tree-context-menu-root="true">
              {[
                ['newFile', 'New File…'],
                ['newFolder', 'New Folder…'],
                ['reveal', 'Reveal in File Explorer'],
                ['cut', 'Cut'],
                ['copy', 'Copy'],
                ['paste', 'Paste'],
                ['fullPath', 'Copy Path'],
                ['relativePath', 'Copy Relative Path'],
                ['rename', 'Rename…'],
                ['delete', 'Delete'],
              ].map(([kind, label]) => (
                <Menu.Item key={kind} onClick={() => void action(kind, context?.item.path)}>
                  {label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </section>
  )
}
