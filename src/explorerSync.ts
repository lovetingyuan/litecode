import { preparePresortedFileTreeInput, type FileTree, type FileTreeBatchOperation, type FileTreeMutationEvent } from '@pierre/trees'

// Include implicit parents so empty directories and file/directory replacements
// can be reconciled without rebuilding directories that still exist.
function allPaths(paths: readonly string[]) {
  const result = new Set<string>()
  for (const path of paths) {
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1))
      {result.add(path.slice(0, slash + 1))}
    result.add(path)
  }
  return result
}

export function createExplorerSync(model: FileTree) {
  let current = new Set<string>()
  let applyingSnapshot = false
  function record(event: FileTreeMutationEvent) {
    if (applyingSnapshot) {return}
    if (event.operation === 'batch') {
      event.events.forEach(record)
    } else if (event.operation === 'add') {
      for (const path of allPaths([event.path])) {current.add(path)}
    } else if (event.operation === 'remove') {
      for (const path of current)
        {if (path === event.path || (event.path.endsWith('/') && path.startsWith(event.path))) {current.delete(path)}}
    } else if (event.operation === 'move') {
      const moved = [...current].filter(path => path === event.from || (event.from.endsWith('/') && path.startsWith(event.from)))
      for (const path of current)
        {if (path === event.to || (event.to.endsWith('/') && path.startsWith(event.to))) {current.delete(path)}}
      for (const path of moved) {current.delete(path)}
      for (const path of moved)
        {for (const target of allPaths([event.to + path.slice(event.from.length)])) {current.add(target)}}
    }
  }
  const dispose = model.onMutation('*', record)
  return {
    dispose,
    reset(paths: readonly string[]) {
      model.resetPaths({ preparedInput: preparePresortedFileTreeInput(paths) })
      current = allPaths(paths)
    },
    update(paths: readonly string[]) {
      const next = allPaths(paths)
      const operations: FileTreeBatchOperation[] = []
      let removedDirectory: string | null = null
      for (const path of [...current].filter(path => !next.has(path)).sort()) {
        if (removedDirectory && path.startsWith(removedDirectory)) {continue}
        operations.push({ type: 'remove', path, recursive: path.endsWith('/') })
        removedDirectory = path.endsWith('/') ? path : null
      }
      for (const path of next)
        {if (!current.has(path)) {operations.push({ type: 'add', path })}}
      if (operations.length) {
        // The resulting index is already known; replaying every remove against
        // it would make a large scan update quadratic.
        applyingSnapshot = true
        try { model.batch(operations) }
        finally { applyingSnapshot = false }
      }
      current = next
    },
  }
}
