import { prepareFileTreeInput } from '@pierre/trees';
self.onmessage = (event: MessageEvent<{ id: number; paths: string[] }>) => {
  const prepared = prepareFileTreeInput(event.data.paths, { flattenEmptyDirectories: false });
  self.postMessage({ id: event.data.id, paths: prepared.paths });
};
