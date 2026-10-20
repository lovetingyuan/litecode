import { describe, expect, it } from 'vitest';
import { buildSearchResults, searchResultRows, searchRowMatches } from './searchResults';
import type { SearchMatch } from './types';

const match = (path: string, line = 1): SearchMatch => ({ path, documentId: null, version: null, line, column: 1, endLine: line, endColumn: 5, preview: 'function example()', matched: 'func' });
const results = [match('/work/app/src/maps/Map.tsx'), match('/work/app/src/maps/Map.tsx', 2), match('/work/app/src/ui.tsx'), match('/work/readme.md'), match('/work/app/src/maps-other/Map.tsx')];

describe('Search result layouts', () => {
  it('keeps file headings and nested matches in the flat layout', () => {
    const { files } = buildSearchResults(results, '/work');
    const rows = searchResultRows(files, new Set());
    expect(rows.filter(row => row.kind === 'file')).toHaveLength(4);
    expect(rows.every(row => row.depth === (row.kind === 'file' ? 0 : 1))).toBe(true);
    expect(rows.filter(row => row.kind === 'match')).toHaveLength(results.length);
    expect(searchResultRows(files, new Set([files[0].path])).filter(row => row.kind === 'match')).toHaveLength(results.length - files[0].count);
  });

  it('builds directory levels with aggregate counts and preserves original match indices', () => {
    const { tree } = buildSearchResults(results, '/work/');
    const rows = searchResultRows(tree, new Set());
    expect(rows.filter(row => row.kind === 'folder').map(row => [row.name, row.depth, row.count])).toEqual([
      ['app', 0, 4], ['src', 1, 4], ['maps', 2, 2], ['maps-other', 2, 1],
    ]);
    expect(rows.find(row => row.kind === 'file' && row.name === 'Map.tsx')?.depth).toBe(3);
    for (const row of rows) if (row.kind === 'match') expect(results[row.index]).toBe(row.match);
    expect(searchRowMatches(tree[0])).toHaveLength(4);
  });

  it('collapses just the selected subtree, including similarly named sibling folders', () => {
    const { tree } = buildSearchResults(results, '/work');
    const rows = searchResultRows(tree, new Set(['/work/app/src/maps']));
    expect(rows.filter(row => row.kind === 'match').map(row => row.match)).toEqual([results[4], results[2], results[3]]);
    const folder = rows.find(row => row.kind === 'folder' && row.name === 'maps')!;
    expect(searchRowMatches(folder)).toEqual(results.slice(0, 2));
    expect(searchResultRows(tree, new Set(['/work/app'])).map(row => row.kind)).toEqual(['folder', 'file', 'match']);
  });

  it('handles Windows separators, root casing, root files and external files', () => {
    const { tree } = buildSearchResults([match('C:\\Work\\src\\a.ts'), match('C:/Work/b.ts'), match('D:/Other/c.ts')], 'c:\\work\\');
    expect(tree.map(node => node.name)).toEqual(['D:', 'src', 'b.ts']);
    expect(searchResultRows(tree, new Set()).filter(row => row.kind === 'folder').map(row => row.path)).toEqual(['D:', 'D:/Other', 'c:/work/src']);
    const absolute = buildSearchResults([match('/outside/src/a.ts')], null);
    expect(searchResultRows(absolute.tree, new Set()).filter(row => row.kind === 'folder').map(row => row.path)).toEqual(['/outside', '/outside/src']);
    expect(searchResultRows(buildSearchResults([], '/work').tree, new Set())).toEqual([]);
  });
});
