import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../types/types";
import type { HtmlPreviewStarted } from "../types/httpPreview";

vi.mock("./bridge", () => ({
  call: vi.fn(),
  desktop: true,
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../editor/documents", () => ({ save: vi.fn() }));

import { call } from "./bridge";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "../editor/documents";
import { useApp } from "../store/store";
import {
  acceptHttpServices,
  initializeHtmlPreviews,
  previewHtml,
  stopHttpService,
  useHtmlPreviews,
} from "./htmlPreview";

const document: Doc = {
  id: "page",
  path: "C:/project/page.html",
  name: "page.html",
  language: "html",
  version: 1,
  revision: "one",
  encoding: "utf8",
  eol: "LF",
  dirty: false,
};
const started: HtmlPreviewStarted = {
  snapshot: {
    revision: 1,
    services: [{ id: 1, root: "C:/project", port: 5500, url: "http://127.0.0.1:5500/page.html" }],
  },
  url: "http://127.0.0.1:5500/page.html",
};

beforeEach(() => {
  vi.resetAllMocks();
  useApp.setState({
    root: "C:/project",
    docs: { page: { ...document } },
    workspaceEpoch: 0,
    openingWorkspace: null,
  });
  useHtmlPreviews.setState({ revision: -1, services: [], starting: [], stopping: [] });
  vi.mocked(save).mockResolvedValue(undefined);
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(call).mockResolvedValue(started);
});

describe("HTML preview flow", () => {
  it("saves the current file before starting the server and opening the browser", async () => {
    await previewHtml("page");
    expect(save).toHaveBeenCalledWith("page");
    expect(call).toHaveBeenCalledWith("html_preview_start", { path: document.path });
    expect(openUrl).toHaveBeenCalledWith(started.url);
    expect(vi.mocked(save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(call).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(call).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(openUrl).mock.invocationCallOrder[0],
    );
    expect(useHtmlPreviews.getState().services).toEqual(started.snapshot.services);
    expect(useHtmlPreviews.getState().starting).toEqual([]);
  });

  it("uses the path chosen for an untitled HTML document and respects save cancellation", async () => {
    useApp.setState({ docs: { page: { ...document, path: null, dirty: true } } });
    await previewHtml("page");
    expect(call).not.toHaveBeenCalled();
    vi.mocked(save).mockImplementationOnce(async () => {
      useApp.setState({ docs: { page: { ...document, path: "C:/project/new.htm" } } });
    });
    await previewHtml("page");
    expect(call).toHaveBeenCalledWith("html_preview_start", { path: "C:/project/new.htm" });
  });

  it("does not start on save failure, unresolved conflicts or edits made during saving", async () => {
    vi.mocked(save).mockRejectedValueOnce(new Error("Save failed"));
    await expect(previewHtml("page")).rejects.toThrow("Save failed");
    useApp.setState({ docs: { page: { ...document, conflict: true } } });
    await expect(previewHtml("page")).rejects.toThrow("Resolve the file conflict");
    useApp.setState({ docs: { page: { ...document, dirty: true } } });
    await expect(previewHtml("page")).rejects.toThrow("Save all changes");
    expect(call).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(useHtmlPreviews.getState().starting).toEqual([]);
  });

  it("deduplicates clicks and cancels work when the project changes during saving", async () => {
    let finishSaving = () => {};
    const saving = new Promise<void>((resolve) => {
      finishSaving = resolve;
    });
    vi.mocked(save).mockReturnValueOnce(saving);
    const preview = previewHtml("page");
    await previewHtml("page");
    expect(save).toHaveBeenCalledTimes(1);
    useApp.setState({ workspaceEpoch: 1 });
    finishSaving();
    await preview;
    expect(call).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not open a browser for a stale or newly modified document", async () => {
    vi.mocked(call).mockImplementationOnce(async () => {
      useApp.setState({ workspaceEpoch: 1 });
      return started;
    });
    await previewHtml("page");
    expect(openUrl).not.toHaveBeenCalled();
    useApp.setState({ workspaceEpoch: 0 });
    vi.mocked(call).mockImplementationOnce(async () => {
      useApp.setState({ docs: { page: { ...document, dirty: true } } });
      return started;
    });
    await expect(previewHtml("page")).rejects.toThrow("The document changed");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps the service available for retry when the browser cannot open", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("Opener failed"));
    await expect(previewHtml("page")).rejects.toThrow("The HTTP service is running");
    expect(useHtmlPreviews.getState().services).toEqual(started.snapshot.services);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("propagates server errors without opening a browser", async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error("Cannot bind"));
    await expect(previewHtml("page")).rejects.toThrow("Cannot bind");
    expect(openUrl).not.toHaveBeenCalled();
    expect(useHtmlPreviews.getState().starting).toEqual([]);
  });

  it("subscribes before fetching state and ignores snapshots older than events", async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(unlisten);
    vi.mocked(call).mockResolvedValueOnce({ revision: 0, services: [] });
    const cleanup = await initializeHtmlPreviews();
    expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(call).mock.invocationCallOrder[0],
    );
    acceptHttpServices(started.snapshot);
    acceptHttpServices({ revision: 0, services: [] });
    expect(useHtmlPreviews.getState().services).toEqual(started.snapshot.services);
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("stops once while pending and preserves newer service events", async () => {
    acceptHttpServices(started.snapshot);
    let finishStopping = (_snapshot: unknown) => {};
    const stopping = new Promise<unknown>((resolve) => {
      finishStopping = resolve;
    });
    vi.mocked(call).mockReturnValueOnce(stopping);
    const stop = stopHttpService(1);
    await stopHttpService(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("html_preview_stop", { id: 1 });
    acceptHttpServices({ revision: 3, services: started.snapshot.services });
    finishStopping({ revision: 2, services: [] });
    await stop;
    expect(useHtmlPreviews.getState().revision).toBe(3);
    expect(useHtmlPreviews.getState().stopping).toEqual([]);
  });
});
