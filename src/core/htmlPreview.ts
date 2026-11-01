import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { call, desktop, errorMessage } from "./bridge";
import { save } from "../editor/documents";
import { useApp } from "../store/store";
import { isHtmlDocument } from "../utils/media";
import type { HtmlPreviewStarted, HttpServicesSnapshot } from "../types/httpPreview";

export const useHtmlPreviews = create<
  HttpServicesSnapshot & {
    starting: string[];
    stopping: number[];
  }
>(() => ({ revision: -1, services: [], starting: [], stopping: [] }));

export function acceptHttpServices(snapshot: HttpServicesSnapshot) {
  if (snapshot.revision >= useHtmlPreviews.getState().revision) {
    useHtmlPreviews.setState(snapshot);
  }
}

export async function initializeHtmlPreviews(): Promise<() => void> {
  if (!desktop) {
    return () => {};
  }
  const unlisten = await listen<HttpServicesSnapshot>("html-preview-changed", ({ payload }) =>
    acceptHttpServices(payload),
  );
  try {
    acceptHttpServices(await call<HttpServicesSnapshot>("html_preview_list"));
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}

export async function previewHtml(id: string) {
  if (useHtmlPreviews.getState().starting.includes(id)) {
    return;
  }
  const initial = useApp.getState();
  const doc = initial.docs[id];
  if (!doc || !isHtmlDocument(doc) || initial.openingWorkspace !== null) {
    return;
  }
  if (doc.conflict) {
    throw new Error("Resolve the file conflict before opening HTML Preview.");
  }
  useHtmlPreviews.setState((state) => ({ starting: [...state.starting, id] }));
  const currentDocument = () => {
    const state = useApp.getState();
    if (
      state.root !== initial.root ||
      state.workspaceEpoch !== initial.workspaceEpoch ||
      state.openingWorkspace !== null
    ) {
      return undefined;
    }
    return state.docs[id];
  };
  try {
    await save(id);
    const saved = currentDocument();
    if (!saved?.path) {
      return;
    }
    if (saved.dirty || saved.conflict || saved.deleted) {
      throw new Error("Save all changes and resolve file conflicts before opening HTML Preview.");
    }
    const started = await call<HtmlPreviewStarted>("html_preview_start", { path: saved.path });
    acceptHttpServices(started.snapshot);
    const current = currentDocument();
    if (!current || current.path !== saved.path) {
      return;
    }
    if (current.dirty || current.conflict || current.deleted) {
      throw new Error("The document changed while starting HTML Preview. Save it and try again.");
    }
    try {
      await openUrl(started.url);
    } catch (error) {
      throw new Error(
        `The HTTP service is running, but the browser could not open. Retry from the HTTP status button. ${errorMessage(error)}`,
      );
    }
  } finally {
    useHtmlPreviews.setState((state) => ({
      starting: state.starting.filter((docId) => docId !== id),
    }));
  }
}

export async function stopHttpService(id: number) {
  if (useHtmlPreviews.getState().stopping.includes(id)) {
    return;
  }
  useHtmlPreviews.setState((state) => ({ stopping: [...state.stopping, id] }));
  try {
    acceptHttpServices(await call<HttpServicesSnapshot>("html_preview_stop", { id }));
  } finally {
    useHtmlPreviews.setState((state) => ({
      stopping: state.stopping.filter((serviceId) => serviceId !== id),
    }));
  }
}
