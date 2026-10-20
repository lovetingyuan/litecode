import { describe, expect, it } from 'vitest';
import { filterQuickFiles, quickFileSettingsKey } from './quickFileFilters';

const excludes = (settings: Record<string, unknown> = {}) => JSON.parse(quickFileSettingsKey(settings)).excludes;

describe('VS Code quick file exclusions', () => {
  it('excludes dependency and metadata subtrees, but keeps ordinary output and hidden files', () => {
    const visible = ['src/App.ts', '.env', '.vscode/settings.json', 'dist/main.js', 'build/main.js', 'node_modules-other/main.ts'];
    const hidden = ['node_modules/a/index.js', 'packages/a/node_modules/b/index.js', 'bower_components/a/index.js', 'results.code-search', '.git/config', 'nested/.svn/file', 'nested/.hg/file', '.jj/file', 'src/.DS_Store', 'Thumbs.db'];
    expect(filterQuickFiles([...visible, ...hidden], excludes(), true)).toEqual(visible);
  });

  it('merges settings per pattern and lets search.exclude override files.exclude and defaults', () => {
    const rules = excludes({
      'files.exclude': { '**/node_modules': true, '**/cache': true, 'root-only': true },
      'search.exclude': { '**/node_modules': false },
    });
    expect(filterQuickFiles(['node_modules/a.ts', 'src/cache/a.ts', 'root-only/a.ts', 'src/root-only/a.ts', '.git/config'], rules, true)).toEqual(['node_modules/a.ts', 'src/root-only/a.ts']);
    expect(JSON.parse(quickFileSettingsKey({}))).toMatchObject({ useIgnoreFiles: true, useGlobalIgnoreFiles: false, useParentIgnoreFiles: false, followSymlinks: true });
    expect(quickFileSettingsKey({ 'editor.fontSize': 25 })).toBe(quickFileSettingsKey({}));
    expect(excludes({ 'files.exclude': null, 'search.exclude': [] })).toEqual(excludes());
  });

  it('matches opened files against full paths without inheriting excluded parent directories', () => {
    const paths = ['C:\\project\\node_modules\\a\\index.js', 'C:/project/src/main.ts', '\\\\?\\UNC\\server\\share\\node_modules\\a.js'];
    expect(filterQuickFiles(paths, excludes(), false)).toEqual(paths);
    expect(filterQuickFiles(paths, excludes({ 'search.exclude': { '**/node_modules/**': true } }), false)).toEqual([paths[1]]);
    expect(filterQuickFiles(paths, excludes({ 'files.exclude': { 'C:/project/src/**': true } }), false)).toEqual([paths[0], paths[2]]);
    expect(filterQuickFiles(['\\\\?\\C:\\project\\cache\\a.ts'], { 'C:/project/cache/**': true }, false)).toEqual([]);
    expect(filterQuickFiles(['src/main.ts', 'cache/a.ts'], { 'C:/project/cache': true }, true, 'C:\\project')).toEqual(['src/main.ts']);
    expect(filterQuickFiles(paths, { 'src/**': true }, false, 'c:/PROJECT')).toEqual([paths[0], paths[2]]);
  });

  it('uses VS Code sibling clauses, brace alternatives and character ranges', () => {
    const rules = { '**/*.js': { when: '$(basename).ts' }, '**/*.{map,log}': true, '**/temp[0-9].txt': true };
    expect(filterQuickFiles(['src/main.js', 'src/main.ts', 'src/keep.js', 'src/main.map', 'temp1.txt', 'tempX.txt'], rules, true)).toEqual(['src/main.ts', 'src/keep.js', 'tempX.txt']);
    expect(filterQuickFiles(['C:/project/main.js', 'C:/project/main.ts', 'C:/project/keep.js'], rules, false)).toEqual(['C:/project/main.ts', 'C:/project/keep.js']);
  });
});
