import { describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', () => ({ languages: { register: vi.fn(), setTokensProvider: vi.fn(), setMonarchTokensProvider: vi.fn(), setLanguageConfiguration: vi.fn(), IndentAction: { None: 0, IndentOutdent: 2 } } }));
vi.mock('@codingame/monaco-vscode-api/workers/editor.worker?worker', () => ({ default: vi.fn() }));
vi.mock('monaco-languageclient/vscodeApiWrapper', () => ({ MonacoVscodeApiWrapper: vi.fn() }));
vi.mock('./editor-features', () => ({}));

import { languageFor, loadSyntax, monaco } from './monaco';

describe('React language modes', () => {
  it.each([['App.tsx', 'typescriptreact'], ['App.JSX', 'javascriptreact'], ['main.ts', 'typescript'], ['main.js', 'javascript']])('identifies %s as %s', (path, language) => {
    expect(languageFor(path)).toBe(language);
  });

  it.each(['typescriptreact', 'javascriptreact'])('loads syntax and editing rules for %s', async language => {
    await loadSyntax(language);
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(language, expect.objectContaining({ tokenizer: expect.any(Object) }));
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(language, expect.objectContaining({ brackets: expect.any(Array) }));
  });
});

describe('JSON syntax loading', () => {
  it('registers and reuses tokenizers for JSON and JSONC documents', async () => {
    for (const path of ['package.json', 'settings.json', 'keybindings.json', 'config.jsonc']) {
      const language = languageFor(path);
      await loadSyntax(language);
      const provider = vi.mocked(monaco.languages.setTokensProvider).mock.calls.find(([id]) => id === language)![1] as monaco.languages.TokensProvider;
      const result = provider.tokenize('{"name":"LiteCode","count":42,"enabled":true,"empty":null}', provider.getInitialState());
      expect(result.tokens.map(token => token.scopes)).toEqual(expect.arrayContaining([
        'string.key.json', 'string.value.json', 'number.json', 'keyword.json',
      ]));
      if (language === 'jsonc') {
        const comment = provider.tokenize('/* first line', provider.getInitialState());
        const next = provider.tokenize('second line */ "name": "value", // comment', comment.endState);
        expect(next.tokens.map(token => token.scopes)).toEqual(expect.arrayContaining([
          'comment.block.json', 'string.key.json', 'string.value.json', 'comment.line.json',
        ]));
      }
    }
    expect(monaco.languages.setTokensProvider).toHaveBeenCalledTimes(2);
  });
});
