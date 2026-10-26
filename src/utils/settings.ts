import { applyEdits, createScanner, getNodeValue, modify, parseTree, type ParseError } from "jsonc-parser";
import schema from "../config/settings-schema.json";

export const settingsSchema = schema;
const formattingOptions = { insertSpaces: true, tabSize: 2 };
// jsonc-parser's ambient const enum cannot be imported with isolatedModules.
const SyntaxKind = { CommaToken: 5, LineCommentTrivia: 12, LineBreakTrivia: 14, EOF: 17 };

type SettingRule = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: SettingRule[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  items?: SettingRule;
  properties?: Record<string, SettingRule>;
  required?: string[];
  additionalProperties?: boolean | SettingRule;
};

function validSetting(value: unknown, rule: SettingRule): boolean {
  if (rule.anyOf && !rule.anyOf.some((candidate) => validSetting(value, candidate))) {
    return false;
  }
  if (rule.enum && !rule.enum.includes(value)) {
    return false;
  }
  const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
  if (types.length && !types.some((type) => {
    if (type === "null") { return value === null; }
    if (type === "array") { return Array.isArray(value); }
    if (type === "integer") { return typeof value === "number" && Number.isInteger(value); }
    if (type === "object") { return value !== null && typeof value === "object" && !Array.isArray(value); }
    return typeof value === type;
  })) {
    return false;
  }
  if (typeof value === "number" && (!Number.isFinite(value) ||
    (rule.minimum !== undefined && value < rule.minimum) ||
    (rule.maximum !== undefined && value > rule.maximum))) {
    return false;
  }
  if (typeof value === "string" && rule.pattern && !new RegExp(rule.pattern).test(value)) {
    return false;
  }
  if (Array.isArray(value) && rule.items && !value.every((item) => validSetting(item, rule.items!))) {
    return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (rule.required?.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) { return false; }
    for (const [key, item] of Object.entries(object)) {
      const property = rule.properties && Object.prototype.hasOwnProperty.call(rule.properties, key) ? rule.properties[key] : undefined;
      if (property ? !validSetting(item, property) : rule.additionalProperties === false) { return false; }
      if (!property && typeof rule.additionalProperties === "object" && !validSetting(item, rule.additionalProperties)) {
        return false;
      }
    }
  }
  return true;
}

export function settingValue(settings: Record<string, unknown>, key: keyof typeof schema.properties): unknown {
  const rule = schema.properties[key];
  const value = settings[key];
  return value !== undefined && validSetting(value, rule) ? value : rule.default;
}

const groupTitles = ["编辑器", "工作台与面包屑", "文件", "搜索", "终端", "语言与工具", "其他"];
const groupHeadings = new Set(groupTitles.map((title) => `// --- LiteCode: ${title} ---`));
function settingGroup(key: string) {
  const prefix = key.split(".")[0];
  if (prefix === "editor" || prefix === "diffEditor" || prefix === "merge-conflict") { return 0; }
  if (prefix === "workbench" || prefix === "breadcrumbs") { return 1; }
  if (prefix === "files") { return 2; }
  if (prefix === "search") { return 3; }
  if (prefix === "terminal") { return 4; }
  if (["typescript", "rust-analyzer", "oxfmt", "litecode"].includes(prefix)) { return 5; }
  return 6;
}

// Scan only between top-level properties: nested values and comment-like strings stay verbatim.
function cleanSettingGap(text: string) {
  const scanner = createScanner(text);
  const edits = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.CommaToken ||
      (token === SyntaxKind.LineCommentTrivia && groupHeadings.has(text.slice(scanner.getTokenOffset(), scanner.getPosition())))) {
      edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
    }
  }
  return applyEdits(text, edits);
}

function splitSettingGap(text: string) {
  const cleaned = cleanSettingGap(text);
  const scanner = createScanner(cleaned);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineBreakTrivia) {
      return {
        tail: cleaned.slice(0, scanner.getTokenOffset()).trimEnd(),
        leading: cleaned.slice(scanner.getPosition()),
      };
    }
  }
  return { tail: cleaned.trimEnd(), leading: "" };
}

export function organizeSettings(text: string): string {
  parseConfiguration(text);
  const root = parseTree(text, [], { allowTrailingComma: true })!;
  const properties = root.children ?? [];
  if (!properties.length) { return text; }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.slice(0, properties[0].offset).match(/(?:^|\n)([\t ]*)$/)?.[1] || "  ";
  const close = root.offset + root.length - 1;
  let leading = cleanSettingGap(text.slice(root.offset + 1, properties[0].offset));
  const entries = properties.map((property, index) => {
    const end = property.offset + property.length;
    const gap = text.slice(end, properties[index + 1]?.offset ?? close);
    const parts = splitSettingGap(gap);
    const key = property.children![0].value as string;
    const entry = { key, group: settingGroup(key), leading, raw: text.slice(property.offset, end), tail: parts.tail };
    leading = parts.leading;
    return entry;
  });
  const last = properties[properties.length - 1];
  const scanner = createScanner(text.slice(last.offset + last.length, close));
  let trailingComma = false;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.CommaToken) { trailingComma = true; }
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  entries.sort((a, b) => a.group - b.group ||
    (a.group === 6 ? compare(a.key.split(".")[0], b.key.split(".")[0]) : 0) || compare(a.key, b.key));
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (previous?.group !== entry.group) {
      if (previous) { lines.push(""); }
      lines.push(`${indent}// --- LiteCode: ${groupTitles[entry.group]} ---`);
    } else if (entry.group === 6 && previous.key.split(".")[0] !== entry.key.split(".")[0]) {
      lines.push("");
    }
    if (entry.leading.trim()) { lines.push(indent + entry.leading.trim()); }
    lines.push(indent + entry.raw + (index < entries.length - 1 || trailingComma ? "," : "") + entry.tail);
  }
  if (leading.trim()) { lines.push(indent + leading.trim()); }
  return text.slice(0, root.offset + 1) + eol + lines.join(eol) + eol + text.slice(close);
}

export function parseConfiguration(
  text: string,
  array = false,
): Record<string, unknown> | unknown[] {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || root?.type !== (array ? "array" : "object")) {
    throw new Error(
      array
        ? "Keyboard shortcuts must be a valid JSONC array."
        : "Settings must be a valid JSONC object.",
    );
  }
  return getNodeValue(root);
}

export function updateSetting(text: string, key: string, value: unknown) {
  parseConfiguration(text);
  return applyEdits(text, modify(text, [key], value, { formattingOptions }));
}

export function completeSettings(text: string): string {
  const values = parseConfiguration(text);
  for (const [key, setting] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      text = updateSetting(text, key, setting.default);
    }
  }
  const root = parseTree(text, [], { allowTrailingComma: true })!;
  const edits = [];
  let previousEnd = 0;
  for (const property of root.children ?? []) {
    const key = property.children![0].value as keyof typeof schema.properties;
    const setting = Object.prototype.hasOwnProperty.call(schema.properties, key)
      ? schema.properties[key]
      : undefined;
    if (
      setting &&
      !text.slice(previousEnd, property.offset).includes(`// ${setting.description}`)
    ) {
      const indent = text.slice(0, property.offset).match(/(?:^|\n)([\t ]*)[^\n]*$/)?.[1] ?? "  ";
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      edits.push({
        offset: property.offset,
        length: 0,
        content: `// ${setting.description}${eol}${indent}// 默认值：${JSON.stringify(setting.default)}${eol}${indent}`,
      });
    }
    previousEnd = property.offset + property.length;
  }
  return organizeSettings(applyEdits(text, edits));
}
