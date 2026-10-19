import { prepareFileTreeInput } from '@pierre/trees';
self.onmessage = (event: MessageEvent<{ id: number; root: string; paths: string[] }>) => {
  const prepared = prepareFileTreeInput(event.data.paths, { flattenEmptyDirectories: false });
  self.postMessage({ id: event.data.id, root: event.data.root, paths: prepared.paths });
};
