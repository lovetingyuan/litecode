import type { NoteMeta, NotepadFormat, NotepadSort, NotepadStats } from "../types/notepad";

export const DEFAULT_NOTEPAD_FORMAT = "txt";

export const NOTEPAD_FORMATS: readonly NotepadFormat[] = [
  { id: "txt", label: "Plain Text", language: "plaintext", extensions: ["txt", "text"] },
  { id: "md", label: "Markdown", language: "markdown", extensions: ["md", "markdown"] },
  { id: "json", label: "JSON", language: "json", extensions: ["json"] },
  { id: "jsonc", label: "JSON with Comments", language: "jsonc", extensions: ["jsonc"] },
  { id: "yaml", label: "YAML", language: "yaml", extensions: ["yaml", "yml"] },
  { id: "toml", label: "TOML", language: "ini", extensions: ["toml"] },
  { id: "ini", label: "INI", language: "ini", extensions: ["ini", "cfg", "conf"] },
  { id: "xml", label: "XML", language: "xml", extensions: ["xml"] },
  { id: "html", label: "HTML", language: "html", extensions: ["html", "htm"] },
  { id: "css", label: "CSS", language: "css", extensions: ["css"] },
  { id: "csv", label: "CSV", language: "plaintext", extensions: ["csv", "tsv"] },
  { id: "sql", label: "SQL", language: "sql", extensions: ["sql"] },
  { id: "js", label: "JavaScript", language: "javascript", extensions: ["js", "mjs", "cjs"] },
  { id: "ts", label: "TypeScript", language: "typescript", extensions: ["ts", "mts", "cts"] },
  { id: "py", label: "Python", language: "python", extensions: ["py"] },
  { id: "sh", label: "Shell Script", language: "shell", extensions: ["sh", "bash", "zsh"] },
  { id: "ps1", label: "PowerShell", language: "powershell", extensions: ["ps1"] },
  { id: "env", label: "Env", language: "dotenv", extensions: ["env"] },
  { id: "log", label: "Log", language: "plaintext", extensions: ["log"] },
];

const formatById = new Map<string, NotepadFormat>(NOTEPAD_FORMATS.map((item) => [item.id, item]));

const formatByExtension = new Map<string, NotepadFormat>();
for (const format of NOTEPAD_FORMATS) {
  for (const ext of format.extensions) {
    formatByExtension.set(ext, format);
  }
}

export function resolveFormat(format: string): NotepadFormat {
  const normalized = format.trim().replace(/^\./, "").toLowerCase();
  return formatById.get(normalized) ?? formatByExtension.get(normalized) ?? NOTEPAD_FORMATS[0];
}

export function formatLanguage(format: string): string {
  return resolveFormat(format).language;
}

export function displayNoteName(title: string, format: string): string {
  const ext = resolveFormat(format).id;
  if (ext === "env" && title.toLowerCase().startsWith(".env")) {
    return title;
  }
  const suffix = `.${ext}`;
  return title.toLowerCase().endsWith(suffix) ? title : `${title}${suffix}`;
}

export function parseTitleAndFormat(
  rawInput: string,
  fallbackFormat: string,
): { title: string; format: string } | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === ".env" || trimmed.toLowerCase().startsWith(".env.")) {
    return { title: trimmed, format: "env" };
  }
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < trimmed.length - 1) {
    const ext = trimmed.slice(dotIndex + 1).toLowerCase();
    const matched = formatByExtension.get(ext);
    if (matched) {
      const stem = trimmed.slice(0, dotIndex).trim();
      if (stem) {
        return { title: stem, format: matched.id };
      }
    }
  }
  return { title: trimmed, format: resolveFormat(fallbackFormat).id };
}

export function computeTextStats(text: string): NotepadStats {
  if (!text) {
    return { lines: 1, words: 0, chars: 0 };
  }
  let lines = 1;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lines++;
    }
    const isWhitespace =
      code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
    if (isWhitespace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return { lines, words, chars: text.length };
}

export function normalizeNotepadSort(raw: unknown): NotepadSort {
  if (raw === "manual" || raw === "updated" || raw === "created" || raw === "title") {
    return raw;
  }
  return "manual";
}

export function sortNotes(notes: readonly NoteMeta[], sort: NotepadSort): NoteMeta[] {
  if (sort === "manual") {
    const pinned: NoteMeta[] = [];
    const unpinned: NoteMeta[] = [];
    for (const note of notes) {
      if (note.pinned) {
        pinned.push(note);
      } else {
        unpinned.push(note);
      }
    }
    return [...pinned, ...unpinned];
  }
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (sort === "title") {
      return displayNoteName(a.title, a.format).localeCompare(displayNoteName(b.title, b.format));
    }
    if (sort === "created") {
      return b.createdAt - a.createdAt;
    }
    return b.updatedAt - a.updatedAt;
  });
}

export function formatRelativeTime(timestampMs: number, now = Date.now()): string {
  const diffSeconds = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSeconds < 45) {
    return "Just now";
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d`;
  }
  const date = new Date(timestampMs);
  const currentYear = new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== currentYear ? { year: "numeric" } : {}),
  });
}

export function makePreview(content: string): string {
  const first =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return first.replace(/\s+/g, " ").slice(0, 140);
}
