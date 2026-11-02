import { call } from "../core/bridge";
import { useApp } from "../store/store";
import type { Doc } from "../types/types";
import type { PackageSnapshot } from "../types/packages";
import { isWorkspacePackageDocument } from "./document";

export async function runPackageCommand(root: string | null, doc: Doc, args: string[]) {
  const state = useApp.getState();
  const current = state.docs[doc.id];
  if (
    !root ||
    state.root !== root ||
    !current ||
    current.path !== doc.path ||
    !isWorkspacePackageDocument(current, root)
  ) {
    throw new Error("Open a package.json in the current workspace to run npm commands.");
  }
  if (current.dirty || current.conflict || current.deleted) {
    throw new Error("Save package.json and resolve file conflicts before running npm commands.");
  }
  const [snapshot, { runTerminalCommand }] = await Promise.all([
    call<PackageSnapshot>("package_snapshot", { root, manifestPath: current.path }),
    import("../terminal/runtime"),
  ]);
  if (
    useApp.getState().root !== root ||
    useApp.getState().workspaceEpoch !== state.workspaceEpoch ||
    useApp.getState().docs[doc.id] !== current
  ) {
    throw new Error("The workspace or package.json changed. Try again.");
  }
  await runTerminalCommand(snapshot.directory, "npm", args);
}
