export type FileClipboard = { sequence: number | null; paths: string[] }
export type CopyReport = {
  copied: { from: string; to: string }[]
  failed: { path: string; message: string }[]
}
type InternalClipboard = FileClipboard & { cut: boolean }
type ClipboardServices = {
  read: () => Promise<FileClipboard>
  confirm: (paths: string[], directory: string, signal: AbortSignal) => Promise<boolean>
  copyExternal: (sequence: number, root: string, directory: string) => Promise<CopyReport>
  pasteInternal: (source: string, destination: string, cut: boolean) => Promise<void>
}

export function pasteDirectory(path: string, directory: boolean) {
  if (!path) return ''
  const clean = path.replace(/\/$/, '')
  return directory ? clean : clean.slice(0, Math.max(0, clean.lastIndexOf('/')))
}

// Events cross the tree's shadow root, so e.target alone misses rename inputs.
export function isEditableTreeEvent(event: { composedPath(): EventTarget[] }) {
  return event.composedPath().some(target => target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable))
}

export function createExplorerClipboard(services: ClipboardServices) {
  let internal: InternalClipboard | null = null
  let revision = 0
  let remembering = Promise.resolve()
  return {
    remember(paths: string[], cut: boolean) {
      const request = ++revision
      internal = null
      remembering = services.read().then(snapshot => {
        if (request === revision) internal = { paths: [...new Set(paths)], cut, sequence: snapshot.sequence }
      }).finally(() => {
        if (request === revision) remembering = Promise.resolve()
      })
      return remembering
    },
    async paste(root: string, directory: string, signal: AbortSignal): Promise<CopyReport | null> {
      const request = revision
      await remembering
      if (signal.aborted || request !== revision) return null
      const snapshot = await services.read()
      if (signal.aborted || request !== revision) return null
      if (internal && internal.sequence !== snapshot.sequence) internal = null
      const source = internal ?? { ...snapshot, cut: false }
      const paths = [...new Set(source.paths)]
      if (!paths.length) return null
      // Copy confirmation belongs to the disk operation, not to Ctrl+C.
      if (!source.cut && !await services.confirm(paths, directory, signal)) return null
      if (signal.aborted || request !== revision) return null
      if (!internal) {
        if (snapshot.sequence === null) return null
        return services.copyExternal(snapshot.sequence, root, directory)
      }
      const current = await services.read()
      if (signal.aborted || request !== revision) return null
      if (current.sequence !== snapshot.sequence) {
        internal = null
        throw new Error('The clipboard changed; paste the files again')
      }
      const report: CopyReport = { copied: [], failed: [] }
      const sources = paths.filter(path => !paths.some(parent => parent !== path && path.startsWith(parent.replace(/\/$/, '') + '/')))
      for (const path of sources) {
        if (signal.aborted) break
        const destination = directory.replace(/\/$/, '') + '/' + path.replace(/\/$/, '').split('/').pop()!
        try {
          await services.pasteInternal(path, destination, source.cut)
          report.copied.push({ from: path, to: destination })
        } catch (error) {
          report.failed.push({ path, message: error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error) })
        }
      }
      // Keep failed cut sources available for retry; completed moves must not run again.
      if (source.cut && request === revision) {
        const completed = report.copied.map(item => item.from)
        const remaining = paths.filter(path => !completed.some(parent => path === parent || path.startsWith(parent.replace(/\/$/, '') + '/')))
        internal = remaining.length ? { ...source, paths: remaining } : null
      }
      return report
    },
  }
}
