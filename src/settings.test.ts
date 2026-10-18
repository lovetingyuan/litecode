import { describe, expect, it } from 'vitest';
import { completeSettings, parseConfiguration, settingsSchema, updateSetting } from './settings';

describe('Annotated settings', () => {
  it('shows every default and description, and is unchanged when opened again', () => {
    const text = completeSettings('{}\n');
    const values = parseConfiguration(text) as Record<string, unknown>;
    for (const [key, setting] of Object.entries(settingsSchema.properties)) {
      expect(values[key]).toEqual(setting.default);
      expect(text).toContain(`// ${setting.description}`);
      expect(text).toContain(`// 默认值：${JSON.stringify(setting.default)}`);
    }
    expect(completeSettings(text)).toBe(text);
  });

  it('preserves custom values, unknown keys, comments and JSON string contents', () => {
    const original = '{\r\n  // 我的行高\r\n  "editor.lineHeight": 28,\r\n  "constructor": "custom",\r\n  /* 保留 */ "custom": { "url": "https://example.com/*literal*/", },\r\n}\r\n';
    const text = completeSettings(original);
    expect(text).toContain('// 我的行高');
    expect(text).toContain('/* 保留 */');
    expect(text).toContain('\r\n');
    expect(parseConfiguration(text)).toMatchObject({ 'editor.lineHeight': 28, custom: { url: 'https://example.com/*literal*/' } });
    expect(completeSettings(text)).toBe(text);
    const updated = updateSetting(text, 'files.autoSave', 'afterDelay');
    expect(updated).toContain('// 我的行高');
    expect(updated).toContain('/* 保留 */');
    expect(parseConfiguration(updated)).toMatchObject({ 'files.autoSave': 'afterDelay', 'editor.lineHeight': 28 });
  });

  it('rejects malformed configuration instead of replacing it with defaults', () => {
    for (const text of ['{"broken": }', '[]', 'null', '{ /* unfinished']) expect(() => completeSettings(text)).toThrow();
    expect(parseConfiguration('[ // shortcut\n {"key":"ctrl+s","command":"save"},\n]', true)).toHaveLength(1);
  });
});
