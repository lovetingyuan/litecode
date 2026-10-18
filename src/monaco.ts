import * as monaco from 'monaco-editor';
import EditorWorker from '@codingame/monaco-vscode-api/workers/editor.worker?worker';
import { MonacoVscodeApiWrapper } from 'monaco-languageclient/vscodeApiWrapper';
import './editor-features';

let startup: Promise<void> | undefined;
export function initializeEditor(): Promise<void> {
  return startup ??= (async () => {
    const wrapper = new MonacoVscodeApiWrapper({
      $type: 'classic', viewsConfig: { $type: 'EditorService' },
      monacoWorkerFactory: () => { globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }; },
      userConfiguration: { json: JSON.stringify({ 'editor.fontFamily': 'Consolas, "Courier New", monospace', 'editor.fontSize': 14, 'editor.tabSize': 4 }) },
    });
    await wrapper.start();
    monaco.editor.defineTheme('dark-modern', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '6A9955' }, { token: 'keyword', foreground: 'C586C0' },
        { token: 'string', foreground: 'CE9178' }, { token: 'number', foreground: 'B5CEA8' },
        { token: 'type.identifier', foreground: '4EC9B0' }, { token: 'identifier', foreground: '9CDCFE' },
      ],
      colors: {
        'editor.background': '#1f1f1f', 'editor.foreground': '#cccccc', 'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#cccccc', 'editor.selectionBackground': '#264f78',
        'editor.lineHighlightBackground': '#ffffff05', 'editor.lineHighlightBorder': '#ffffff0a',
        'editorWidget.background': '#202020', 'editorWidget.border': '#454545', 'focusBorder': '#0078d4',
        'editorIndentGuide.background1': '#404040', 'editorIndentGuide.activeBackground1': '#707070',
        'editorSuggestWidget.background': '#202020', 'editorSuggestWidget.selectedBackground': '#04395e',
      },
    });
    monaco.editor.setTheme('dark-modern');
  })();
}

export function languageFor(path: string): string {
  if (/(?:^|[\\/])(settings|keybindings)\.json$/i.test(path) || /\.jsonc$/i.test(path)) return 'jsonc';
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json', rs: 'rust', html: 'html', htm: 'html', css: 'css', scss: 'scss', md: 'markdown', py: 'python', yaml: 'yaml', yml: 'yaml', toml: 'ini', sh: 'shell', ps1: 'powershell', sql: 'sql', xml: 'xml', svg: 'xml', c: 'c', cpp: 'cpp', h: 'cpp', go: 'go', java: 'java', txt: 'plaintext', 'code-search': 'search-result' } as Record<string, string>)[extension ?? ''] ?? 'plaintext';
}

const loaded = new Set<string>();
const syntaxes = import.meta.glob<{ language: monaco.languages.IMonarchLanguage; conf: monaco.languages.LanguageConfiguration }>(['/node_modules/monaco-languages/esm/vs/languages/definitions/*/*.js', '!**/register.js']);
export async function loadSyntax(language: string) {
  if (loaded.has(language) || language === 'plaintext') return;
  loaded.add(language);
  const id = language === 'javascript' ? 'typescript' : language === 'jsonc' ? 'json' : language;
  const loader = syntaxes[`/node_modules/monaco-languages/esm/vs/languages/definitions/${id}/${id}.js`];
  if (!loader) return;
  const module = await loader();
  monaco.languages.register({ id: language });
  monaco.languages.setMonarchTokensProvider(language, module.language);
  monaco.languages.setLanguageConfiguration(language, module.conf);
}
export { monaco };
