import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { call, desktop, errorMessage } from "../core/bridge";
import { manageWorkspaceTrust, trustedCall } from "../core/workspaceTrust";
import { useApp, setApp, notify } from "../store/store";
import { ask } from "../components/dialog";
import { layoutGroups, type SplitDirection } from "../editor/editorLayout";
import {
  activePane,
  addSplit,
  addTab,
  patchPane,
  removePane,
  selectPane,
  terminalSelections,
  useTerminal,
  type Profile,
} from "./state";
import {
  plainTerminalText,
  reportedDirectory,
  terminalOptions,
  terminalSetting,
} from "./settings";
import { quoteDroppedPaths } from "./drop";

type Created = {
  id: string;
  profile: Profile;
  cwd: string;
  integration: boolean;
  pid?: number;
  windowsBuild: number;
};
type Event = { kind: string; exitCode: number | null; error: string | null };
type Runtime = {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  node: HTMLDivElement;
  observer: ResizeObserver;
  sessionId?: string;
  starting?: Promise<void>;
  disposed: boolean;
  visible: boolean;
  webgl?: WebglAddon;
  frame?: number;
  ack: number;
  cwd?: string;
  cwdUpdate: Promise<unknown>;
  input: Promise<unknown>;
  output: Channel<ArrayBuffer | number[]>;
  events: Channel<Event>;
  integration: boolean;
  shellKind?: string;
  cols: number;
  rows: number;
};
const runtimes = new Map<string, Runtime>();
const sources = new Map<string, string>();
let profilesRequest: Promise<void> | undefined;
let bellContext: AudioContext | undefined;
const get = (name: string) => terminalSetting(useApp.getState().settings, name);
const report = (error: unknown) => notify(errorMessage(error));

export async function refreshProfiles() {
  if (!desktop) {
    return;
  }
  const list = await call<{
    profiles: Profile[];
    defaultProfile: string | null;
  }>("terminal_profiles");
  useTerminal.setState({
    profiles: list.profiles,
    defaultProfile: list.defaultProfile,
  });
}
export function showTerminal(toggle = false) {
  if (!useApp.getState().ready) {
    return;
  }
  if (toggle && useApp.getState().view === "terminal") {
    setApp({ view: "editor" });
    return;
  }
  setApp({ view: "terminal" });
  profilesRequest ??= refreshProfiles()
    .catch(report)
    .finally(() => {
      profilesRequest = undefined;
    });
  if (!useTerminal.getState().initialized) {
    addTab();
  }
  requestAnimationFrame(() => focusTerminal());
}
export function newTerminal(profile?: string) {
  if (!useApp.getState().ready) {
    return;
  }
  setApp({ view: "terminal" });
  const id = addTab(profile);
  void refreshProfiles().catch(report);
  return id;
}
export async function splitTerminal(
  direction: SplitDirection = "right",
  source = activePane(),
) {
  const runtime = source && runtimes.get(source);
  if (!source || !runtime) {
    return;
  }
  await runtime.starting;
  await runtime.cwdUpdate;
  if (
    runtime.disposed ||
    !runtime.sessionId ||
    useTerminal.getState().panes[source]?.status !== "running"
  ) {
    return;
  }
  if (
    !useTerminal.getState().panes[source]?.reportedCwd &&
    get("splitCwd") === "inherited"
  ) {
    notify(
      "Shell has not reported its current directory. The split will use its last known directory.",
    );
  }
  const id = addSplit(source, direction);
  if (id) {
    sources.set(id, runtime.sessionId);
  }
}
export function focusTerminal(id = activePane()) {
  if (!id) {
    return;
  }
  const state = useTerminal.getState();
  const tab = state.tabs.find(tab => layoutGroups(tab.layout).includes(id));
  if (tab && tab.id !== state.activeTab) {
    useTerminal.setState({ activeTab: tab.id });
    requestAnimationFrame(() => runtimes.get(id)?.terminal.focus());
  }
  selectPane(id);
  runtimes.get(id)?.terminal.focus();
}
export function selectTab(id: string) {
  useTerminal.setState({ activeTab: id });
  requestAnimationFrame(() => focusTerminal());
}
export function nextTerminal(delta: number) {
  const s = useTerminal.getState();
  if (!s.tabs.length) {
    return;
  }
  selectTab(
    s.tabs[
      (s.tabs.findIndex((t) => t.id === s.activeTab) + delta + s.tabs.length) %
        s.tabs.length
    ].id,
  );
}
export function moveFocus(direction: "left" | "right" | "up" | "down") {
  const id = activePane();
  const current =
    id && document.querySelector<HTMLElement>(`[data-terminal-pane="${id}"]`);
  if (!current) {
    return;
  }
  const box = current.getBoundingClientRect();
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const horizontal = direction === "left" || direction === "right";
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-terminal-pane]"),
  )
    .filter((el) => el !== current && el.getBoundingClientRect().width > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const dx = r.x + r.width / 2 - x,
        dy = r.y + r.height / 2 - y;
      const along = horizontal ? dx : dy,
        across = horizontal ? dy : dx;
      return {
        id: el.dataset.terminalPane!,
        along,
        score: Math.abs(along) + Math.abs(across) * 2,
      };
    })
    .filter((c) =>
      direction === "left" || direction === "up" ? c.along < -1 : c.along > 1,
    )
    .sort((a, b) => a.score - b.score);
  if (candidates[0]) {
    focusTerminal(candidates[0].id);
  }
}

function disposeRuntime(id: string) {
  const r = runtimes.get(id);
  if (!r) {
    return;
  }
  r.disposed = true;
  if (r.frame) {
    cancelAnimationFrame(r.frame);
  }
  r.observer.disconnect();
  r.terminal.dispose();
  r.node.remove();
  runtimes.delete(id);
  terminalSelections.delete(id);
  if (r.sessionId) {
    void call("terminal_close", { id: r.sessionId }).catch(report);
  }
}
export function closePane(id = activePane()) {
  if (!id) {
    return;
  }
  disposeRuntime(id);
  sources.delete(id);
  removePane(id);
  requestAnimationFrame(() => focusTerminal());
}
export function closeTab(id: string) {
  const tab = useTerminal.getState().tabs.find((t) => t.id === id);
  if (tab) {
    layoutGroups(tab.layout).forEach(closePane);
  }
}
export function resetTerminals() {
  Array.from(runtimes.keys()).forEach(disposeRuntime);
  sources.clear();
  useTerminal.setState({
    tabs: [],
    activeTab: null,
    panes: {},
    initialized: false,
    find: false,
  });
}
export async function restartPane(id: string) {
  const pane = useTerminal.getState().panes[id];
  const root = useApp.getState().root;
  if (!pane) {
    return;
  }
  if (pane.errorCode === "workspaceTrust" && !(await manageWorkspaceTrust())) {
    return;
  }
  if (useApp.getState().root !== root || useTerminal.getState().panes[id] !== pane) {
    return;
  }
  disposeRuntime(id);
  sources.delete(id);
  patchPane(id, {
    status: "starting",
    error: undefined,
    errorCode: undefined,
    exitCode: undefined,
    reportedCwd: false,
    attempt: (useTerminal.getState().panes[id]?.attempt ?? 0) + 1,
  });
}

function acknowledge(r: Runtime) {
  if (!r.sessionId || !r.ack || r.disposed) {
    return;
  }
  const bytes = r.ack;
  r.ack = 0;
  void call("terminal_ack", { id: r.sessionId, bytes }).catch((error) => {
    if (!r.disposed) {
      report(error);
    }
  });
}
function updateCwd(id: string, r: Runtime, cwd: string) {
  r.cwd = cwd;
  patchPane(id, { cwd, reportedCwd: true });
  if (r.sessionId) {
    r.cwdUpdate = r.cwdUpdate
      .catch(() => {})
      .then(() =>
        r.disposed
          ? undefined
          : call("terminal_update_cwd", { id: r.sessionId, cwd }),
      )
      .catch((error) => {
        if (!r.disposed) {
          patchPane(id, { reportedCwd: false });
          report(error);
        }
      });
  }
}
function sendInput(id: string, r: Runtime, text: string | Uint8Array) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  r.input = r.input
    .catch(() => {})
    .then(async () => {
      await r.starting;
      if (
        r.disposed ||
        !r.sessionId ||
        useTerminal.getState().panes[id]?.status !== "running"
      ) {
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        await call("terminal_write", {
          id: r.sessionId,
          data: Array.from(bytes.subarray(offset, offset + 64 * 1024)),
        });
      }
    })
    .catch((error) => {
      if (!r.disposed) {
        report(error);
      }
    });
}
async function startPane(id: string, r: Runtime) {
  try {
    const root = useApp.getState().root;
    const pane = useTerminal.getState().panes[id];
    let attempt = 0;
    const created = await trustedCall<Created>("terminal_create", () => {
      // Tauri ends Channels when an invocation is rejected, including a trust prompt.
      if (attempt++) {
        r.output = new Channel(r.output.onmessage);
        r.events = new Channel(r.events.onmessage);
      }
      r.cols = Math.min(1000, r.terminal.cols);
      r.rows = Math.min(1000, r.terminal.rows);
      return {
        profile: pane.profile ?? null,
        source: sources.get(id) ?? null,
        cwd: pane.cwd || null,
        expectedRoot: root,
        cols: r.cols,
        rows: r.rows,
        onOutput: r.output,
        onEvent: r.events,
      };
    });
    if (r.disposed || useApp.getState().root !== root) {
      await call("terminal_close", { id: created.id });
      return;
    }
    r.sessionId = created.id;
    if (created.windowsBuild) { r.terminal.options.windowsPty = { backend: "conpty", buildNumber: created.windowsBuild }; }
    r.integration = created.integration;
    r.shellKind = created.profile.kind;
    patchPane(id, {
      profile: created.profile.name,
      initialCwd: created.cwd,
      cwd: r.cwd ?? created.cwd,
      status: "running",
    });
    if (r.cwd) {
      updateCwd(id, r, r.cwd);
    }
    acknowledge(r);
    scheduleFit(r);
  } catch (error) {
    if (!r.disposed) {
      const message = errorMessage(error);
      patchPane(id, {
        status: "error",
        error: message,
        errorCode: (error as { code?: string } | null)?.code,
      });
      r.terminal.writeln(`\r\n\x1b[31m${plainTerminalText(message)}\x1b[0m`);
    }
  }
}

function scheduleFit(r: Runtime) {
  if (r.disposed || r.frame) {
    return;
  }
  r.frame = requestAnimationFrame(() => {
    r.frame = undefined;
    if (
      !r.visible ||
      !r.node.isConnected ||
      r.node.clientWidth < 20 ||
      r.node.clientHeight < 20
    ) {
      return;
    }
    r.fit.fit();
    if (
      r.sessionId &&
      (r.cols !== r.terminal.cols || r.rows !== r.terminal.rows)
    ) {
      r.cols = Math.min(1000, r.terminal.cols);
      r.rows = Math.min(1000, r.terminal.rows);
      void call("terminal_resize", {
        id: r.sessionId,
        cols: r.cols,
        rows: r.rows,
      }).catch((error) => {
        if (!r.disposed) {
          report(error);
        }
      });
    }
  });
}
function setGpu(r: Runtime) {
  if (!r.visible || get("gpuAcceleration") === "off") {
    r.webgl?.dispose();
    r.webgl = undefined;
    return;
  }
  if (r.webgl || !r.node.isConnected) {
    return;
  }
  const addon = new WebglAddon();
  try {
    addon.onContextLoss(() => {
      addon.dispose();
      r.webgl = undefined;
    });
    r.terminal.loadAddon(addon);
    r.webgl = addon;
  } catch {
    addon.dispose();
    r.webgl = undefined;
  }
}

function createRuntime(id: string): Runtime {
  const terminal = new Terminal(terminalOptions(useApp.getState().settings));
  const fit = new FitAddon(),
    search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.ctrlKey && /^https?:\/\//i.test(uri)) {
        void openUrl(uri).catch(report);
      }
    }),
  );
  const node = document.createElement("div");
  node.className = "terminal-surface";
  const r: Runtime = {
    terminal,
    fit,
    search,
    node,
    disposed: false,
    visible: true,
    ack: 0,
    cwdUpdate: Promise.resolve(),
    input: Promise.resolve(),
    output: new Channel(),
    events: new Channel(),
    integration: false,
    cols: 80,
    rows: 24,
    observer: new ResizeObserver(() => scheduleFit(r)),
  };
  r.output.onmessage = (value) => {
    if (r.disposed) {
      return;
    }
    const bytes = new Uint8Array(value);
    terminal.write(bytes, () => {
      r.ack += bytes.byteLength;
      acknowledge(r);
    });
  };
  r.events.onmessage = (event) => {
    if (r.disposed) {
      return;
    }
    if (
      event.kind === "closed" &&
      ["error", "exited"].includes(
        useTerminal.getState().panes[id]?.status ?? "",
      )
    ) {
      return;
    }
    terminal.write("", () => {
      if (r.disposed) {
        return;
      }
      if (event.kind === "exit" && event.exitCode === 0 && !event.error) {
        closePane(id);
        return;
      }
      const message =
        event.error ?? `Shell exited with code ${event.exitCode ?? "unknown"}.`;
      patchPane(id, {
        status: event.kind === "exit" ? "exited" : "error",
        exitCode: event.exitCode ?? undefined,
        error: message,
      });
      terminal.writeln(`\r\n\x1b[31m${plainTerminalText(message)}\x1b[0m`);
      if (r.sessionId) {
        void call("terminal_close", { id: r.sessionId }).catch(report);
      }
    });
  };
  terminal.onData((text) => sendInput(id, r, text));
  terminal.onBinary(data => sendInput(id, r, Uint8Array.from(data, character => character.charCodeAt(0))));
  terminal.onSelectionChange(() => {
    if (terminal.hasSelection()) {
      terminalSelections.add(id);
    } else {
      terminalSelections.delete(id);
    }
    if (get("copyOnSelection") && terminal.hasSelection()) {
      void copyTerminal(id).catch(report);
    }
  });
  terminal.onTitleChange((title) => {
    node.title = plainTerminalText(title).slice(0, 120);
  });
  terminal.onBell(() => {
    if (!get("enableBell")) {
      return;
    }
    bellContext ??= new AudioContext();
    void bellContext
      .resume()
      .then(() => {
        const oscillator = bellContext!.createOscillator(),
          gain = bellContext!.createGain();
        oscillator.frequency.value = 800;
        gain.gain.value = 0.04;
        oscillator.connect(gain);
        gain.connect(bellContext!.destination);
        oscillator.start();
        oscillator.stop(bellContext!.currentTime + 0.08);
      })
      .catch(report);
  });
  for (const osc of [7, 9, 633]) {
    terminal.parser.registerOscHandler(osc, (data) => {
      const cwd = reportedDirectory(osc, data);
      if (cwd) {
        updateCwd(id, r, cwd);
        return true;
      }
      return false;
    });
  }
  terminal.registerLinkProvider({
    provideLinks: (y, callback) => {
      const line =
        terminal.buffer.active.getLine(y - 1)?.translateToString() ?? "";
      const links: ILink[] = [];
      const urls = Array.from(line.matchAll(/https?:\/\/\S+/g));
      const pattern =
        /(?:[a-zA-Z]:[\\/]|\.\.?[\\/]|[\w.@-]+[\\/])[^\s<>"|]+|[\w.@-]+\.[a-zA-Z\d]+(?::\d+(?::\d+)?)?/g;
      for (const match of line.matchAll(pattern)) {
        const text = match[0].replace(/[),;]+$/, "");
        if (/https?:/i.test(text) || !text) {
          continue;
        }
        const index = match.index ?? 0;
        if (
          urls.some(
            (url) => index >= url.index! && index < url.index! + url[0].length,
          )
        ) {
          continue;
        }
        links.push({
          text,
          range: {
            start: { x: index + 1, y },
            end: { x: index + text.length, y },
          },
          activate: (event) => {
            if (event.ctrlKey) {
              void openFileLink(id, text).catch(report);
            }
          },
        });
      }
      callback(links);
    },
  });
  node.addEventListener(
    "paste",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteTerminal(
        id,
        event.clipboardData?.getData("text/plain") ?? "",
      ).catch(report);
    },
    true,
  );
  node.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey && get("mouseWheelZoom")) {
        event.preventDefault();
        zoomTerminal(event.deltaY < 0 ? 1 : -1, id);
      }
    },
    { passive: false },
  );
  runtimes.set(id, r);
  return r;
}

export function mountPane(id: string, host: HTMLElement) {
  const r = runtimes.get(id) ?? createRuntime(id);
  host.append(r.node);
  r.visible = host.getBoundingClientRect().width > 0;
  if (!r.terminal.element) {
    r.terminal.open(r.node);
    r.fit.fit();
  }
  r.observer.observe(r.node);
  setGpu(r);
  scheduleFit(r);
  if (!r.starting) {
    r.starting = startPane(id, r);
  }
  if (activePane() === id && useApp.getState().view === "terminal") {
    requestAnimationFrame(() => {
      if (!r.disposed && r.visible) {
        r.terminal.focus();
      }
    });
  }
  return () => {
    r.observer.disconnect();
    r.visible = false;
    setGpu(r);
    r.node.remove();
  };
}
export function setPaneVisible(id: string, visible: boolean) {
  const r = runtimes.get(id);
  if (!r) {
    return;
  }
  r.visible = visible;
  setGpu(r);
  if (visible) {
    scheduleFit(r);
  }
}
export function hasTerminalSelection() {
  const id = activePane();
  return !!id && !!runtimes.get(id)?.terminal.hasSelection();
}
export async function copyTerminal(id = activePane()) {
  const r = id && runtimes.get(id);
  if (!r) {
    return;
  }
  const text = r.terminal.getSelection();
  if (text) {
    if (desktop) {
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  }
}
export async function pasteTerminal(id = activePane(), text?: string) {
  const r = id && runtimes.get(id);
  if (!r || r.disposed) {
    return;
  }
  text ??= desktop
    ? ((await readText()) ?? "")
    : await navigator.clipboard.readText();
  const warning = get("enableMultiLinePasteWarning");
  if (
    /\r|\n/.test(text) &&
    (warning === "always" ||
      (warning === "auto" && !r.terminal.modes.bracketedPasteMode))
  ) {
    if (
      (await ask(
        "Paste multiple lines?",
        "Pasting multiple lines into a shell can execute commands immediately.",
        ["Paste", "Cancel"],
      )) !== "Paste"
    ) {
      return;
    }
  }
  if (!r.disposed) {
    r.terminal.paste(text);
    r.terminal.focus();
  }
}
export async function pasteDroppedPaths(id: string, paths: string[]) {
  const r = runtimes.get(id);
  if (!paths.length || !r || r.disposed || useTerminal.getState().panes[id]?.status !== "running") {
    return;
  }
  focusTerminal(id);
  await pasteTerminal(id, quoteDroppedPaths(paths, r.shellKind));
}
export function clearTerminal() {
  const id = activePane();
  if (id) {
    runtimes.get(id)?.terminal.clear();
  }
}
export function zoomTerminal(delta: number, id = activePane()) {
  const r = id && runtimes.get(id);
  if (!r) {
    return;
  }
  r.terminal.options.fontSize =
    delta === 0
      ? Number(get("fontSize"))
      : Math.min(100, Math.max(6, (r.terminal.options.fontSize ?? 14) + delta));
  scheduleFit(r);
}
export function findTerminal(
  text: string,
  previous = false,
  regex = false,
  caseSensitive = false,
) {
  const id = activePane(),
    r = id && runtimes.get(id);
  if (!r) {
    return false;
  }
  if (!text) {
    r.search.clearDecorations();
    return false;
  }
  try {
    return previous
      ? r.search.findPrevious(text, { regex, caseSensitive })
      : r.search.findNext(text, { regex, caseSensitive });
  } catch {
    return false;
  }
}
export function selectTerminalWord(
  id: string,
  event: { clientX: number; clientY: number },
) {
  const r = runtimes.get(id);
  if (!r) {
    return;
  }
  const screen = r.node.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!screen) {
    return;
  }
  const col = Math.max(
    0,
    Math.floor((event.clientX - screen.x) / (screen.width / r.terminal.cols)),
  );
  const row =
    Math.max(
      0,
      Math.floor(
        (event.clientY - screen.y) / (screen.height / r.terminal.rows),
      ),
    ) + r.terminal.buffer.active.viewportY;
  const text = r.terminal.buffer.active.getLine(row)?.translateToString() ?? "";
  let start = col,
    end = col;
  while (start > 0 && /\S/.test(text[start - 1])) {
    start--;
  }
  while (end < text.length && /\S/.test(text[end])) {
    end++;
  }
  r.terminal.select(start, row, end - start);
}
async function openFileLink(id: string, text: string) {
  const pane = useTerminal.getState().panes[id];
  if (!pane) {
    return;
  }
  const match = text.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)!;
  const file = match[1];
  const path = /^[a-z]:[\\/]|^[/\\]/i.test(file)
    ? file
    : `${pane.cwd.replace(/[\\/]+$/, "")}/${file}`;
  const granted = await call<string>("explicit_open", { path });
  const { openPath } = await import("../editor/documents");
  await openPath(granted, {
    pinned: true,
    line: match[2] ? Number(match[2]) : undefined,
    column: match[3] ? Number(match[3]) : undefined,
  });
}

useApp.subscribe((state, previous) => {
  if (state.root !== previous.root) {
    resetTerminals();
  }
  if (state.settings !== previous.settings) {
    for (const r of runtimes.values()) {
      r.terminal.options = terminalOptions(state.settings);
      setGpu(r);
      scheduleFit(r);
    }
  }
});
