import { call } from "./bridge";
import { ask } from "../components/dialog";
import { useApp } from "../store/store";

const restricted = new Set<string>();
const prompts = new Map<string, { controller: AbortController; pending: Promise<boolean> }>();

export type WorkspaceOpenInfo = { path: string; trusted: boolean; alreadyOpen: boolean };
export type WorkspaceTrustDecision = { root: string; trusted: boolean };

export function rememberWorkspaceTrust(root: string, isRestricted: boolean) {
  if (isRestricted) { restricted.add(root); } else { restricted.delete(root); }
}

export async function prepareWorkspaceOpen(path: string): Promise<(WorkspaceOpenInfo & { trust?: WorkspaceTrustDecision }) | null> {
  cancelWorkspaceTrustPrompt();
  const info = await call<WorkspaceOpenInfo>("workspace_open_info", { path });
  if (info.trusted || info.alreadyOpen) { return info; }
  const choice = await ask(
    "Do you trust the authors of this folder?",
    `Terminals, language services and formatters can execute code from this folder. Restricted Mode keeps text editing available.\n\n${info.path}`,
    ["Restricted Mode", "Trust Workspace"],
  );
  if (!choice) { return null; }
  return { ...info, trust: { root: info.path, trusted: choice === "Trust Workspace" } };
}

export function cancelWorkspaceTrustPrompt() {
  for (const { controller } of prompts.values()) {
    controller.abort();
  }
}

export async function manageWorkspaceTrust(root = useApp.getState().root) {
  if (!root) {
    return;
  }
  cancelWorkspaceTrustPrompt();
  const choice = await ask(
    "Workspace Trust",
    `Only trust folders from authors you trust. Terminals, language services and formatters can execute code from this folder.\n\n${root}`,
    ["Restricted Mode", "Trust Workspace", "Cancel"],
  );
  if (!choice || choice === "Cancel" || useApp.getState().root !== root) {
    return;
  }
  const trusted = choice === "Trust Workspace";
  await call("set_workspace_trust", { expectedRoot: root, trusted });
  if (trusted) {
    restricted.delete(root);
  } else {
    restricted.add(root);
  }
  return trusted;
}

function requestTrust(root: string) {
  if (restricted.has(root)) {
    return Promise.resolve(false);
  }
  const existing = prompts.get(root);
  if (existing) {
    return existing.pending;
  }
  const controller = new AbortController();
  const pending = (async () => {
    const choice = await ask(
      "Do you trust the authors of this folder?",
      `Terminals, language services and formatters can execute code from this folder. Restricted Mode keeps text editing available.\n\n${root}`,
      ["Restricted Mode", "Trust Workspace"],
      { signal: controller.signal },
    );
    if (controller.signal.aborted || useApp.getState().root !== root) {
      return false;
    }
    if (choice !== "Trust Workspace") {
      restricted.add(root);
      return false;
    }
    await call("set_workspace_trust", { expectedRoot: root, trusted: true });
    return true;
  })().finally(() => prompts.delete(root));
  prompts.set(root, { controller, pending });
  return pending;
}

function requestFormatterTrust(root: string | null, directory: string, path: unknown) {
  const key = `formatter:${root ?? ""}:${directory}`;
  const existing = prompts.get(key);
  if (existing) { return existing.pending; }
  const controller = new AbortController();
  const pending = (async () => {
    const choice = await ask(
      "Trust formatters from this folder?",
      `Formatters and their configuration can execute code with your user permissions. Only approve folders from authors you trust. This permission lasts for this window and workspace context.\n\n${directory}`,
      ["Trust Formatters", "Cancel"],
      { signal: controller.signal },
    );
    if (choice !== "Trust Formatters" || controller.signal.aborted || useApp.getState().root !== root) {
      return false;
    }
    await call("trust_formatter", { path: path ?? null, expectedRoot: root, directory });
    return !controller.signal.aborted && useApp.getState().root === root;
  })().finally(() => prompts.delete(key));
  prompts.set(key, { controller, pending });
  return pending;
}

export async function trustedCall<T>(
  command: string,
  args?: Record<string, unknown> | (() => Record<string, unknown>),
): Promise<T> {
  const root = useApp.getState().root;
  const argumentsForCall = () => (typeof args === "function" ? args() : args);
  const attempted = new Set<string>();
  for (;;) {
    const currentArgs = argumentsForCall();
    try {
      return await call<T>(command, currentArgs);
    } catch (error) {
      const { code, trustPath } = (error ?? {}) as { code?: string; trustPath?: string };
      if (useApp.getState().root !== root) { throw error; }
      if (command === "format_document" && code === "formatterTrust" && typeof trustPath === "string" && trustPath) {
        if (attempted.has(trustPath)) { throw error; }
        attempted.add(trustPath);
        if (!(await requestFormatterTrust(root, trustPath, currentArgs?.path))) { throw error; }
      } else if (code === "workspaceTrust" && root && !attempted.has("workspace")) {
        if (useApp.getState().openingWorkspace != null) { throw error; }
        attempted.add("workspace");
        if (!(await requestTrust(root))) { throw error; }
      } else {
        throw error;
      }
      if (useApp.getState().root !== root) { throw error; }
    }
  }
}
