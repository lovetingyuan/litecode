import type { CopyReport } from './explorerClipboard'

export type DropItem = { path: string; directory: boolean }
export type ResolvedDrop = { batchId: string; items: DropItem[]; failed: CopyReport['failed'] }
export type ExternalCopyPlan = { destination: string; existing: string | null; directory?: boolean }

export function hasExternalFiles(transfer: Pick<DataTransfer, 'types'> | null) {
  return !!transfer?.types.includes('Files') && !transfer.types.includes('application/litecode-tab')
}

export function externalDropDirectory(path: string | undefined, directory: boolean) {
  const clean = path?.replace(/\/$/, '') ?? ''
  return directory ? clean : clean.slice(0, Math.max(0, clean.lastIndexOf('/')))
}

type CopyServices = {
  plan: (index: number) => Promise<ExternalCopyPlan>
  confirm: (item: DropItem, plan: ExternalCopyPlan) => Promise<string | null>
  copy: (index: number, plan: ExternalCopyPlan) => Promise<{ from: string; to: string }>
}

export async function copyDroppedItems(items: DropItem[], services: CopyServices, signal: AbortSignal) {
  const report: CopyReport = { copied: [], failed: [] }
  for (const [index, item] of items.entries()) {
    if (signal.aborted) break
    try {
      const plan = await services.plan(index)
      if (signal.aborted) break
      if (plan.existing !== null) {
        const choice = await services.confirm(item, plan)
        if (signal.aborted || !choice || choice === 'Cancel') break
        if (choice === 'Skip') continue
      }
      if (signal.aborted) break
      report.copied.push(await services.copy(index, plan))
    } catch (error) {
      report.failed.push({ path: item.path, message: typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error) })
    }
  }
  return report
}

export async function openDroppedItems(items: DropItem[], services: {
  folder: (path: string, newWindow: boolean) => Promise<unknown>
  file: (path: string) => Promise<unknown>
}, signal: AbortSignal) {
  const failed: CopyReport['failed'] = []
  let folders = 0
  // Establish the workspace first; mixed files always belong to the original window.
  for (const item of [...items.filter(i => i.directory), ...items.filter(i => !i.directory)]) {
    if (signal.aborted) break
    try {
      if (item.directory) await services.folder(item.path, folders++ > 0)
      else await services.file(item.path)
    } catch (error) {
      failed.push({ path: item.path, message: typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error) })
    }
  }
  return failed
}

export type ExplorerDropTarget = {
  element: HTMLElement
  directory: string
  hover?: () => void
  scroll?: HTMLElement
}
export type ExternalExplorer = {
  resolve: (path: EventTarget[]) => ExplorerDropTarget | null
  copy: (drop: ResolvedDrop, directory: string, signal: AbortSignal) => Promise<void>
}
let explorer: ExternalExplorer | null = null
export function registerExternalExplorer(value: ExternalExplorer) {
  explorer = value
  return () => { if (explorer === value) explorer = null }
}
export function externalExplorer() { return explorer }
