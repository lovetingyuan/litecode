import { useEffect, useRef, useState } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import {
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type ContextMenuItem as FileTreeContextMenuItem,
  type ContextMenuOpenContext as FileTreeContextMenuOpenContext,
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
  normalize,
  pin,
} from './documents'
import { ask, input } from './dialog'
import { Icon, IconButton } from './ui'
import type { TreeSnapshot } from './types'

let clipboard: { paths: string[]; cut: boolean } | null = null
const scans = new Map<string, Promise<void>>()
export function refreshTree() {
  const root = useApp.getState().root
  if (!root) return Promise.resolve()
  const previous = scans.get(root)
  if (previous) return previous
  const current = call<TreeSnapshot>('scan_workspace')
    .then(tree => {
      if (useApp.getState().root === root) setApp({ tree })
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
  window.dispatchEvent(new CustomEvent('reveal-tree', { detail: relative(path) }))
}

export function Explorer({ openFolder }: { openFolder: () => void }) {
  const root = useApp(s => s.root)
  const tree = useApp(s => s.tree)
  const groups = useApp(s => s.groups)
  const docs = useApp(s => s.docs)
  const activeGroup = useApp(s => s.activeGroup)
  const [context, setContext] = useState<{
    item: FileTreeContextMenuItem
    context: FileTreeContextMenuOpenContext
  } | null>(null)
  const worker = useRef<Worker | null>(null)
  const generation = useRef(0)
  const operationQueue = useRef(Promise.resolve())
  const [expanded, setExpanded] = useState(true)
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
      /* Keep each level at 14px and its guide centered under the parent icon. */
      [data-item-section="spacing"]{padding-left:0;margin-right:calc(-1 * var(--trees-item-row-gap))}
      [data-item-section="spacing"] > [data-item-section="spacing-item"]{
        width:14px;box-sizing:border-box;flex-shrink:0;margin:0;
        transform:translateX(calc(var(--trees-icon-width) / 2 - .5px));
      }
    `,
    renaming: { onRename: e => mutate(e.sourcePath, e.destinationPath), onError: notify },
    dragAndDrop: {
      onDropComplete: e => {
        for (const from of e.draggedPaths) {
          const name = basename(from.replace(/\/$/, ''))
          const to = e.target.directoryPath
            ? `${e.target.directoryPath.replace(/\/$/, '')}/${name}`
            : name
          if (from.replace(/\/$/, '') !== to) mutate(from, to)
        }
      },
      onDropError: notify,
    },
    onSelectionChange: paths => {
      if (paths.length === 1 && !model.getItem(paths[0])?.isDirectory() && rootRef.current)
        void openPath(join(rootRef.current, paths[0])).catch(e => notify(errorMessage(e)))
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
    const w = new PrepareWorker()
    worker.current = w
    w.onmessage = (event: MessageEvent<{ id: number; paths: string[] }>) => {
      if (event.data.id === generation.current)
        model.resetPaths({ preparedInput: preparePresortedFileTreeInput(event.data.paths) })
    }
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [model])
  useEffect(() => {
    worker.current?.postMessage({ id: ++generation.current, paths: tree.paths })
  }, [tree.paths])
  useEffect(() => {
    model.setGitStatus(
      tree.git.map(g => ({ ...g, status: g.status === 'conflicted' ? 'modified' : g.status })),
    )
  }, [model, tree.git])
  useEffect(() => {
    const onReveal = (e: Event) =>
      model.scrollToPath((e as CustomEvent<string>).detail, { focus: true })
    window.addEventListener('reveal-tree', onReveal)
    return () => window.removeEventListener('reveal-tree', onReveal)
  }, [model])
  const active = docs[groups.find(g => g.id === activeGroup)?.active ?? '']
  useEffect(() => {
    if (active?.path && root && normalize(active.path).startsWith(normalize(root)))
      model.scrollToPath(relative(active.path, root))
  }, [model, active?.path, root])

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
          <div className="section-heading">
            <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
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
              onDoubleClick={() => {
                const id = useApp
                  .getState()
                  .groups.find(g => g.id === useApp.getState().activeGroup)?.active
                if (id) pin(id)
              }}
              onKeyDown={e => {
                if (e.key === 'F2') {
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
