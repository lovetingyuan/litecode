import { describe, expect, it } from "vitest";
import { completeSettings, organizeSettings, parseConfiguration, settingsSchema, settingValue, updateSetting } from "./settings";

describe("Annotated settings", () => {
  it("shows every default and description, and is unchanged when opened again", () => {
    const text = completeSettings("{}\n");
    const values = parseConfiguration(text) as Record<string, unknown>;
    for (const [key, setting] of Object.entries(settingsSchema.properties)) {
      expect(values[key]).toEqual(setting.default);
      expect(text).toContain(`// ${setting.description}`);
      expect(text).toContain(`// 默认值：${JSON.stringify(setting.default)}`);
    }
    expect(completeSettings(text)).toBe(text);
  });

  it("preserves custom values, unknown keys, comments and JSON string contents", () => {
    const original =
      '{\r\n  // 我的行高\r\n  "editor.lineHeight": 28,\r\n  "constructor": "custom",\r\n  /* 保留 */ "custom": { "url": "https://example.com/*literal*/", },\r\n}\r\n';
    const text = completeSettings(original);
    expect(text).toContain("// 我的行高");
    expect(text).toContain("/* 保留 */");
    expect(text).toContain("\r\n");
    expect(parseConfiguration(text)).toMatchObject({
      "editor.lineHeight": 28,
      custom: { url: "https://example.com/*literal*/" },
    });
    expect(completeSettings(text)).toBe(text);
    const updated = updateSetting(text, "files.autoSave", "afterDelay");
    expect(updated).toContain("// 我的行高");
    expect(updated).toContain("/* 保留 */");
    expect(parseConfiguration(updated)).toMatchObject({
      "files.autoSave": "afterDelay",
      "editor.lineHeight": 28,
    });
  });

  it("rejects malformed configuration instead of replacing it with defaults", () => {
    for (const text of ['{"broken": }', "[]", "null", "{ /* unfinished"]) {
      expect(() => completeSettings(text)).toThrow();
    }
    expect(
      parseConfiguration('[ // shortcut\n {"key":"ctrl+s","command":"save"},\n]', true),
    ).toHaveLength(1);
  });
});

describe("Organizing settings JSONC", () => {
  it.each(["\n", "\r\n"])("sorts groups and keys without changing values or comments (%j)", (eol) => {
    const input = [
      "// File header", "{",
      '  // 自定义终端说明', '  "terminal.integrated.fontSize": 17, // terminal tail',
      '  /* Unknown property */ "z.custom": { "url": "https://x/*literal*/", "b": [2,1,], },',
      '  "editor.wordWrap": "bounded", /* wrap tail', '     multiline */',
      '  // 字体说明', '  "editor.fontSize": 18,',
      '  "search.exclude": { "**/z": true, "**/a": false },',
      '  "breadcrumbs.enabled": false,', '  "files.autoSave": "off",',
      '  "litecode.nodePath": null,', '  "a.custom": 1,',
      '  // File footer', '}', '// Outside footer', '',
    ].join(eol);
    const result = organizeSettings(input);
    expect(parseConfiguration(result)).toEqual(parseConfiguration(input));
    expect(result).toMatch(/^\/\/ File header/);
    expect(result).toContain('"terminal.integrated.fontSize": 17, // terminal tail');
    expect(result).toContain('"editor.wordWrap": "bounded", /* wrap tail' + eol + '     multiline */');
    expect(result).toContain('// 字体说明' + eol + '  "editor.fontSize": 18');
    expect(result).toContain('"url": "https://x/*literal*/", "b": [2,1,],');
    expect(result).toContain('"**/z": true, "**/a": false');
    expect(result).toMatch(/\/\/ File footer\r?\n}\r?\n\/\/ Outside footer\r?\n$/);
    const groups = ["编辑器", "工作台与面包屑", "文件", "搜索", "终端", "语言与工具", "其他"];
    const positions = groups.map((title) => result.indexOf(`// --- LiteCode: ${title} ---`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(result.indexOf('"editor.fontSize"')).toBeLessThan(result.indexOf('"editor.wordWrap"'));
    expect(result.indexOf('"a.custom"')).toBeLessThan(result.indexOf('"z.custom"'));
    expect(organizeSettings(result)).toBe(result);
    if (eol === "\r\n") { expect(result.replace(/\r\n/g, "")).not.toContain("\n"); }
  });

  it("preserves duplicate-key precedence and associates inline comments before a comma", () => {
    const input = '{"z":0 /* zero */, "editor.tabSize":2, /* first */ "editor.tabSize":8, "a":1}';
    const result = organizeSettings(input);
    expect(result.match(/"editor.tabSize"/g)).toHaveLength(2);
    expect(parseConfiguration(result)).toEqual(parseConfiguration(input));
    expect(result).toContain('"z":0 /* zero */');
    expect(organizeSettings(result)).toBe(result);
  });

  it("does not fill workspace defaults, change nested order, or duplicate its headings", () => {
    const input = '{\n\t"files.exclude": {"z":true,"a":false,},\n\t"editor.tabSize":2,\n}\n';
    const result = organizeSettings(input);
    expect(Object.keys(parseConfiguration(result))).toEqual(["editor.tabSize", "files.exclude"]);
    expect(result).toContain('\t// --- LiteCode: 编辑器 ---');
    expect(result).toContain('{"z":true,"a":false,}');
    expect(organizeSettings(result)).toBe(result);
    expect(organizeSettings('{ /* keep empty */ }')).toBe('{ /* keep empty */ }');
  });

  it("keeps each unknown namespace together even when punctuation changes full-key ordering", () => {
    const result = organizeSettings('{"a-b.z":1,"a.z":2,"a":3,"a.a":4,"a-b.a":5}');
    expect(Object.keys(parseConfiguration(result))).toEqual(["a", "a.a", "a.z", "a-b.a", "a-b.z"]);
    expect(organizeSettings(result)).toBe(result);
  });

  it("rejects broken JSONC instead of discarding text", () => {
    for (const input of ['{"broken": }', '[]', 'null', '{ /* unfinished']) {
      expect(() => organizeSettings(input)).toThrow();
    }
  });
});

describe("Schema-backed setting values", () => {
  it("uses every schema default for missing settings", () => {
    for (const [key, rule] of Object.entries(settingsSchema.properties)) {
      expect(settingValue({}, key as keyof typeof settingsSchema.properties)).toEqual(rule.default);
      expect(settingValue({ [key]: rule.default }, key as keyof typeof settingsSchema.properties)).toEqual(rule.default);
    }
  });

  it.each([
    ["editor.lineNumbers", "relative"], ["editor.guides.bracketPairs", "active"],
    ["editor.hover.enabled", "onKeyboardModifier"], ["editor.fontWeight", 550],
    ["editor.fontWeight", "550"], ["editor.rulers", [80, { column: 120, color: "#ff0000" }]],
    ["editor.quickSuggestions", false], ["editor.quickSuggestions", { comments: true, other: "on" }],
    ["editor.wordWrap", "bounded"], ["editor.insertSpaces", false],
  ] as const)("accepts supported values for %s: %j", (key, value) => {
    expect(settingValue({ [key]: value }, key)).toEqual(value);
  });

  it.each([
    ["editor.fontSize", NaN], ["editor.fontSize", Infinity], ["editor.fontSize", "16"],
    ["editor.fontSize", 0], ["editor.tabSize", 2.5], ["editor.wordWrapColumn", 0],
    ["editor.hover.delay", -1], ["editor.lineNumbers", "invalid"], ["editor.folding", "false"],
    ["editor.fontWeight", "heavy"], ["editor.fontWeight", 1001],
    ["editor.rulers", [80, "bad"]], ["editor.rulers", [{ color: "red" }]],
    ["editor.quickSuggestions", { comments: 1 }], ["editor.quickSuggestions", { unknown: true }],
  ] as const)("falls back for invalid %s: %j", (key, value) => {
    expect(settingValue({ [key]: value }, key)).toEqual(settingsSchema.properties[key].default);
  });
});
