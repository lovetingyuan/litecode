import { prepareQuickFiles, searchQuickFiles, type FileSearchMessage, type FileSearchReply } from './quickFiles';

let workspace: ReturnType<typeof prepareQuickFiles> = [];
let open: ReturnType<typeof prepareQuickFiles> = [];
self.onmessage = ({ data }: MessageEvent<FileSearchMessage>) => {
  if (data.kind === 'workspace') {
    const root = data.root?.replace(/[\\/]$/, '');
    workspace = prepareQuickFiles(root ? data.paths.filter(p => !p.endsWith('/')).map(p => `${root}/${p}`) : [], data.root);
  } else if (data.kind === 'open') {open = prepareQuickFiles(data.paths, data.root);}
  else {self.postMessage({ id: data.id, version: data.version, files: searchQuickFiles(workspace, open, data.query) } satisfies FileSearchReply);}
};
