import {
  prepareQuickFiles,
  searchQuickFiles,
  type FileSearchMessage,
  type FileSearchReply,
} from "./quickFiles";
import { filterQuickFiles } from "../utils/quickFileFilters";

let workspace: ReturnType<typeof prepareQuickFiles> = [];
let open: ReturnType<typeof prepareQuickFiles> = [];
self.onmessage = ({ data }: MessageEvent<FileSearchMessage>) => {
  if (data.kind === "workspace") {
    const root = data.root?.replace(/[\\/]$/, "");
    workspace = prepareQuickFiles(
      root
        ? filterQuickFiles(data.paths, data.excludes ?? {}, true, data.root).map(
            (p) => `${root}/${p}`,
          )
        : [],
      data.root,
    );
  } else if (data.kind === "open") {
    open = prepareQuickFiles(
      filterQuickFiles(data.paths, data.excludes ?? {}, false, data.root),
      data.root,
    );
  } else {
    self.postMessage({
      id: data.id,
      version: data.version,
      files: searchQuickFiles(workspace, open, data.query),
    } satisfies FileSearchReply);
  }
};
