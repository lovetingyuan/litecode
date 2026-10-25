import type { ITerminalOptions } from "@xterm/xterm";
import schema from "../config/settings-schema.json";

export function terminalSetting(
  settings: Record<string, unknown>,
  name: string,
): unknown {
  const key = `terminal.integrated.${name}` as keyof typeof schema.properties;
  const rule = schema.properties[key] as
    | {
        default: unknown;
        type?: string | string[];
        enum?: unknown[];
        minimum?: number;
        maximum?: number;
      }
    | undefined;
  if (!rule) {
    return;
  }
  const value = settings[key];
  if (value === undefined || (rule.enum && !rule.enum.includes(value))) {
    return rule.default;
  }
  const types = Array.isArray(rule.type)
    ? rule.type
    : rule.type
      ? [rule.type]
      : [];
  if (
    types.length &&
    !types.some((type) =>
      type === "null"
        ? value === null
        : type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : type === "object"
            ? typeof value === "object" &&
              value !== null &&
              !Array.isArray(value)
            : typeof value === type,
    )
  ) {
    return rule.default;
  }
  if (
    typeof rule.default === "number" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < rule.minimum! ||
      value > rule.maximum! ||
      (rule.type === "integer" && !Number.isInteger(value)))
  ) {
    return rule.default;
  }
  if (!types.length && rule.default !== null && typeof value !== typeof rule.default) {
    return rule.default;
  }
  return value;
}
function weight(
  value: unknown,
  fallback: "normal" | "bold",
): ITerminalOptions["fontWeight"] {
  if (value === "normal" || value === "bold") {
    return value;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 900
    ? (number as ITerminalOptions["fontWeight"])
    : fallback;
}
export function terminalOptions(
  settings: Record<string, unknown>,
): ITerminalOptions {
  const get = (name: string) => terminalSetting(settings, name);
  return {
    fontFamily: String(
      get("fontFamily") ||
        settings["editor.fontFamily"] ||
        'Consolas, "Courier New", monospace',
    ),
    fontSize: get("fontSize") as number,
    fontWeight: weight(get("fontWeight"), "normal"),
    fontWeightBold: weight(get("fontWeightBold"), "bold"),
    lineHeight: get("lineHeight") as number,
    letterSpacing: get("letterSpacing") as number,
    scrollback: get("scrollback") as number,
    cursorStyle: get("cursorStyle") as ITerminalOptions["cursorStyle"],
    cursorBlink: get("cursorBlinking") as boolean,
    smoothScrollDuration: get("smoothScrolling") ? 125 : 0,
    allowProposedApi: true,
    theme: {
      background: "#1f1f1f",
      foreground: "#cccccc",
      cursor: "#aeafad",
      selectionBackground: "#264f78",
      black: "#000000",
      red: "#cd3131",
      green: "#0dbc79",
      yellow: "#e5e510",
      blue: "#2472c8",
      magenta: "#bc3fbc",
      cyan: "#11a8cd",
      white: "#e5e5e5",
      brightBlack: "#666666",
      brightRed: "#f14c4c",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#3b8eea",
      brightMagenta: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#ffffff",
    },
  };
}

// oxlint-disable no-control-regex -- Terminal control bytes must never become paths or visible error text.
export function plainTerminalText(text: string) {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}
export function reportedDirectory(osc: number, data: string): string | null {
  let path: string | undefined;
  if (osc === 9 && data.startsWith("9;")) {
    path = data.slice(2).replace(/^"|"$/g, "");
  }
  if (osc === 633 && data.startsWith("P;Cwd=")) {
    path = data
      .slice(6)
      .replace(/\\x([\da-f]{2})|\\\\/gi, (_m, hex?: string) =>
        hex ? String.fromCharCode(parseInt(hex, 16)) : "\\",
      );
  }
  if (osc === 7) {
    try {
      const url = new URL(data);
      if (
        url.protocol !== "file:" ||
        (url.hostname &&
          url.hostname !== "localhost" &&
          !/^[a-z0-9_-]+$/i.test(url.hostname))
      ) {
        return null;
      }
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, "$1");
    } catch {
      return null;
    }
  }
  return path &&
    (/^[a-z]:[\\/]/i.test(path) || path.startsWith("/")) &&
    !/[\x00-\x1f]/.test(path)
    ? path
    : null;
}
