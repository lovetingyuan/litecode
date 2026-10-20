import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { call, desktop, errorMessage } from './bridge'
import { useApp, notify } from './store'
import { openPath, pathTitle } from './documents'
import { openFolder } from './commands'
import { externalExplorer, hasExternalFiles, openDroppedItems, type DropItem, type ExplorerDropTarget, type ResolvedDrop } from './externalDrop'

type NativeWebview = { postMessageWithAdditionalObjects: (message: unknown, files: File[]) => void }

export function useExternalDrop(ready: boolean) {
  useEffect(() => {
    if (!desktop || !ready) {return}
    let disposed = false
    let active: AbortController | null = null
    let changingWorkspace = false
    let highlighted: HTMLElement | null = null
    let hover: ReturnType<typeof setTimeout> | undefined
    let scroll: ReturnType<typeof setInterval> | undefined
    let hoverDirectory: string | undefined
    const pending = new Map<string, { resolve: (drop: ResolvedDrop) => void; reject: (e: Error) => void }>()
    function clear() {
      highlighted?.removeAttribute('data-external-drop')
      highlighted = null
      clearTimeout(hover); clearInterval(scroll)
      hoverDirectory = undefined
    }
    function target(event: DragEvent): { tree: ExplorerDropTarget | null; group: string; element: HTMLElement } | null {
      const path = event.composedPath()
      if (document.querySelector('[role="dialog"]')) {return null}
      const tree = externalExplorer()?.resolve(path) ?? null
      if (tree) {return { tree, element: tree.element, group: useApp.getState().activeGroup }}
      const group = path.find(e => e instanceof HTMLElement && e.matches('.editor-group')) as HTMLElement | undefined
      const area = group ?? path.find(e => e instanceof HTMLElement && e.matches('.editors, .explorer')) as HTMLElement | undefined
      return area ? { tree: null, group: group?.dataset.groupId ?? useApp.getState().activeGroup, element: area } : null
    }
    function onOver(event: DragEvent) {
      if (!hasExternalFiles(event.dataTransfer)) {return}
      event.preventDefault(); event.stopPropagation()
      const dropTarget = target(event)
      if (event.dataTransfer) {event.dataTransfer.dropEffect = dropTarget ? 'copy' : 'none'}
      if (!dropTarget) { clear(); return }
      if (highlighted !== dropTarget.element) {
        clear()
        highlighted = dropTarget.element
        highlighted.setAttribute('data-external-drop', 'true')
      }
      const tree = dropTarget.tree
      if (tree?.hover && hoverDirectory !== tree.directory) {
        clearTimeout(hover)
        hoverDirectory = tree.directory
        hover = setTimeout(tree.hover, 650)
      }
      clearInterval(scroll)
      if (tree?.scroll) {
        const el = tree.scroll
        const bounds = el.getBoundingClientRect()
        const delta = event.clientY < bounds.top + 30 ? -14 : event.clientY > bounds.bottom - 30 ? 14 : 0
        if (delta) {scroll = setInterval(() => { el.scrollTop += delta }, 30)}
      }
    }
    function onLeave(event: DragEvent) { if (!event.relatedTarget) {clear()} }
    async function perform(event: DragEvent) {
      if (!hasExternalFiles(event.dataTransfer)) {return}
      event.preventDefault(); event.stopPropagation()
      const dropTarget = target(event)
      const files = Array.from(event.dataTransfer?.files ?? [])
      clear()
      if (!dropTarget || !files.length) {return}
      active?.abort()
      const controller = new AbortController()
      active = controller
      const batchId = crypto.randomUUID()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const bridge = (window as Window & { chrome?: { webview?: NativeWebview } }).chrome?.webview
        if (!bridge?.postMessageWithAdditionalObjects) {throw new Error('External file drops require the Windows desktop app and a current WebView2 runtime.')}
        const received = new Promise<ResolvedDrop>((resolve, reject) => {
          pending.set(batchId, { resolve, reject })
          timeout = setTimeout(() => reject(new Error('Could not resolve the dropped files. Please drag them again.')), 15000)
          controller.signal.addEventListener('abort', () => reject(new DOMException('Drop cancelled', 'AbortError')), { once: true })
        })
        // File objects must cross the native boundary before the drop callback yields.
        // Wry's earlier native listener requires a string and aborts dispatch for objects.
        try { bridge.postMessageWithAdditionalObjects(JSON.stringify({ type: 'litecode-external-drop', batchId }), files) }
        catch (error) { pending.get(batchId)?.reject(new Error(errorMessage(error))) }
        const drop = await received
        if (controller.signal.aborted) {return}
        if (drop.failed.length) {notify(drop.failed.map(f => `${pathTitle(f.path)}: ${f.message}`).join('\n'))}
        if (dropTarget.tree) {await externalExplorer()?.copy(drop, dropTarget.tree.directory, controller.signal)}
        else {
          const items = await call<DropItem[]>('authorize_external_drop', { batchId })
          const failed = await openDroppedItems(items, {
            folder: async (path, newWindow) => {
              changingWorkspace = true
              try { await openFolder(newWindow, path) } finally { changingWorkspace = false }
            },
            file: path => openPath(path, { pinned: true, group: dropTarget.group }),
          }, controller.signal)
          if (failed.length) {notify(failed.map(f => `${pathTitle(f.path)}: ${f.message}`).join('\n'))}
        }
      } catch (error) {
        if (!controller.signal.aborted) {notify(errorMessage(error))}
      } finally {
        clearTimeout(timeout)
        pending.delete(batchId)
        await call('release_external_drop', { batchId }).catch(() => {})
        if (active === controller) {active = null}
      }
    }
    const unsubscribe = useApp.subscribe((s, previous) => {
      if (s.root !== previous.root && !changingWorkspace) { active?.abort(); clear() }
    })
    let unlisten: (() => void) | undefined
    void listen<ResolvedDrop>('external-drop-resolved', ({ payload }) => {
      const request = pending.get(payload.batchId)
      if (request) {request.resolve(payload)}
      else {void call('release_external_drop', { batchId: payload.batchId }).catch(() => {})}
    }).then(off => {
      if (disposed) { off(); return }
      unlisten = off
      window.addEventListener('dragover', onOver, true)
      window.addEventListener('drop', perform, true)
      window.addEventListener('dragleave', onLeave, true)
      window.addEventListener('dragend', clear, true)
    }).catch(e => notify(errorMessage(e)))
    return () => {
      disposed = true; active?.abort(); clear(); unsubscribe(); unlisten?.()
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('drop', perform, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('dragend', clear, true)
    }
  }, [ready])
}
