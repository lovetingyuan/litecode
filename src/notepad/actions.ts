import { desktop, errorMessage } from "../core/bridge";
import { ask, input } from "../components/dialog";
import { notify } from "../store/store";
import type { NoteMeta } from "../types/notepad";
import { displayNoteName } from "./formats";
import { deleteNote, ensureNoteContentLoaded, renameNote } from "./runtime";
import { useNotepad } from "./state";

export function runNotepadAction(operation: Promise<unknown>) {
  void operation.catch((error) => notify(errorMessage(error)));
}

export async function promptRenameNote(note: NoteMeta) {
  const value = await input("Rename Note", displayNoteName(note.title, note.format));
  if (value) {
    await renameNote(note.id, value);
  }
}

export async function confirmDeleteNote(note: NoteMeta) {
  const loadedText = useNotepad.getState().contents[note.id];
  const hasContent =
    loadedText !== undefined ? loadedText.trim().length > 0 : note.preview.trim().length > 0;
  if (hasContent) {
    const choice = await ask(
      "Delete Note",
      `Delete "${displayNoteName(note.title, note.format)}"? This cannot be undone.`,
      ["Delete", "Cancel"],
      { defaultChoice: "Cancel" },
    );
    if (choice !== "Delete") {
      return;
    }
  }
  await deleteNote(note.id);
}

export async function copyNoteContent(id: string) {
  const text = await ensureNoteContentLoaded(id);
  if (desktop) {
    await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
  notify("Copied note content to clipboard.");
}
