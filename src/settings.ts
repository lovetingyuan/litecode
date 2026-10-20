import { applyEdits, getNodeValue, modify, parseTree, type ParseError } from 'jsonc-parser';
import schema from './settings-schema.json';

export const settingsSchema = schema;
const formattingOptions = { insertSpaces: true, tabSize: 2 };

export function parseConfiguration(text: string, array = false): Record<string, unknown> | unknown[] {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || root?.type !== (array ? 'array' : 'object')) {throw new Error(array ? 'Keyboard shortcuts must be a valid JSONC array.' : 'Settings must be a valid JSONC object.');}
  return getNodeValue(root);
}

export function updateSetting(text: string, key: string, value: unknown) {
  parseConfiguration(text);
  return applyEdits(text, modify(text, [key], value, { formattingOptions }));
}

export function completeSettings(text: string): string {
  const values = parseConfiguration(text);
  for (const [key, setting] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {text = updateSetting(text, key, setting.default);}
  }
  const root = parseTree(text, [], { allowTrailingComma: true })!;
  const edits = [];
  let previousEnd = 0;
  for (const property of root.children ?? []) {
    const key = property.children![0].value as keyof typeof schema.properties;
    const setting = Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : undefined;
    if (setting && !text.slice(previousEnd, property.offset).includes(`// ${setting.description}`)) {
      const indent = text.slice(0, property.offset).match(/(?:^|\n)([\t ]*)[^\n]*$/)?.[1] ?? '  ';
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      edits.push({ offset: property.offset, length: 0, content: `// ${setting.description}${eol}${indent}// 默认值：${JSON.stringify(setting.default)}${eol}${indent}` });
    }
    previousEnd = property.offset + property.length;
  }
  return applyEdits(text, edits);
}
