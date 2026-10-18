import { describe, it, expect } from 'vitest';
import { rankPath, parseLocation } from './fuzzy';
import { matchesWhen, normalizeKey, resolveBinding } from './keybindings';

describe('User keyboard configuration', () => {
  it('honors contexts, precedence, removal and multi-step chords', () => {
    expect(normalizeKey('Shift+CTRL+p')).toBe('ctrl+shift+p');
    expect(matchesWhen('editorTextFocus && (resourceLangId == typescript || !inputFocus)', { editorTextFocus: true, resourceLangId: 'json', inputFocus: false })).toBe(true);
    expect(matchesWhen('editorTextFocus && unknown', { editorTextFocus: true })).toBe(false);
    expect(matchesWhen('process.exit()', {})).toBe(false);
    const bindings = [{ key: 'ctrl+k ctrl+t', command: 'tools' }, { key: 'ctrl+s', command: '-save' }, { key: 'ctrl+s', command: 'saveAs', when: '!inputFocus' }];
    expect(resolveBinding(bindings, 'Ctrl+K', {}).prefix).toBe(true);
    expect(resolveBinding(bindings, 'ctrl+s', { inputFocus: false }).command).toBe('saveAs');
    expect(resolveBinding(bindings, 'ctrl+s', { inputFocus: true }).removed.has('save')).toBe(true);
  });
});

describe('Quick Open matching', () => {
  it('supports Windows drive prefixes and line/column suffixes', () => {
    expect(parseLocation('C:\\project\\file.ts:12:4')).toEqual({ query: 'C:\\project\\file.ts', line: 12, column: 4 });
    expect(parseLocation('src/App.tsx')).toEqual({ query: 'src/App.tsx' });
  });
  it('prefers filename boundaries and recent files over incidental path matches', () => {
    expect(rankPath('src/App.tsx', 'app')!.score).toBeGreaterThan(rankPath('application/src/component.tsx', 'app')!.score);
    expect(rankPath('src/App.tsx', 'app', true)!.score).toBeGreaterThan(rankPath('src/App.tsx', 'app')!.score);
    expect(rankPath('src/App.tsx', 'xyz')).toBeNull();
    expect(rankPath('src/components/Button.tsx', 'scbt')!.positions).toHaveLength(4);
  });
});
