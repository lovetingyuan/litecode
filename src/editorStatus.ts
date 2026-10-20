import { activeDoc, useApp, setApp } from './store';
import { models, patchDoc, scheduleBackup } from './documents';
import { monaco, loadSyntax } from './monaco';
import type { QuickPick } from './types';

export function changeIndent() {
  const doc = activeDoc(); if (!doc) {return;}
  const active = String(useApp.getState().settings['editor.tabSize'] ?? 4);
  setApp({ quick: { title: 'Select Tab Size', active, items: Array.from({ length: 16 }, (_, i) => {
    const size = i + 1;
    return { id: String(size), label: String(size), description: String(size) === active ? 'Current' : undefined,
      run: () => {
        setApp(s => ({ settings: { ...s.settings, 'editor.tabSize': size } }));
        models.get(doc.id)?.updateOptions({ tabSize: size });
      } };
  }) } });
}

export function changeEncoding() {
  const doc = activeDoc(); if (!doc) {return;}
  const encodings = [['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 with BOM'], ['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'], ['gbk', 'GBK']];
  setApp({ quick: { title: 'Select File Encoding', active: doc.encoding, items: encodings.map(([id, label]) => ({
    id, label, description: id === doc.encoding ? 'Current' : undefined,
    run: () => { if (id !== doc.encoding) {patchDoc(doc.id, { encoding: id, dirty: true }); scheduleBackup();} },
  })) } });
}

export function changeEol() {
  const doc = activeDoc(); if (!doc) {return;}
  setApp({ quick: { title: 'Select End of Line Sequence', active: doc.eol, items: ['LF', 'CRLF'].map(id => ({
    id, label: id, description: id === doc.eol ? 'Current' : undefined,
    run: () => models.get(doc.id)?.pushEOL(id === 'LF' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF),
  })) } });
}

export function changeLanguage() {
  const doc = activeDoc(); if (!doc) {return;}
  const languages = new Map(monaco.languages.getLanguages().map(language => [language.id, language]));
  const items: QuickPick['items'] = [...languages.values()].map(language => ({
    id: language.id, label: language.aliases?.[0] ?? language.id, description: language.id === doc.language ? 'Current' : language.id,
    run: async () => {
      await loadSyntax(language.id);
      const model = models.get(doc.id); if (!model) {return;}
      monaco.editor.setModelLanguage(model, language.id);
      patchDoc(doc.id, { language: language.id }); scheduleBackup();
    },
  })).sort((a, b) => a.label.localeCompare(b.label));
  setApp({ quick: { title: 'Select Language Mode', active: doc.language, items } });
}
