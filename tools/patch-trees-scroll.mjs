import { readFileSync, writeFileSync } from 'node:fs';

// beta.6 clamps scrollTop to the row height total. Include our optional bottom
// space in both that clamp and the virtual layout, without adding a fake row.
const root = new URL('../node_modules/@pierre/trees/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
if (version !== '1.0.0-beta.6') throw new Error('Review the trees scroll padding patch before upgrading @pierre/trees.');

const patches = [
  ['dist/model/layout.js', [
    ['const totalHeight = totalRowCount * metrics.itemHeight;',
      'const totalHeight = totalRowCount * metrics.itemHeight + Math.max(0, metrics.paddingBottom ?? 0);'],
  ]],
  ['dist/render/FileTreeView.js', [
    ['function computeFileTreeViewLayoutState({ controller, itemHeight, overscan, scrollTop, stickyFolders, viewportHeight }) {',
      'function computeFileTreeViewLayoutState({ controller, itemHeight, overscan, scrollTop, stickyFolders, viewportHeight, paddingBottom = 0 }) {'],
    ['\t\titemHeight,\n\t\toverscan,\n\t\tscrollTop,\n\t\tstickyRows:',
      '\t\titemHeight,\n\t\toverscan,\n\t\tpaddingBottom,\n\t\tscrollTop,\n\t\tstickyRows:'],
    ['const maxScrollTop = Math.max(0, nextItemCount * itemHeight - nextViewportHeight);',
      'const paddingBottom = Math.max(0, parseFloat(getComputedStyle(scrollElement).getPropertyValue("--trees-scroll-padding-bottom")) || 0);\n\t\t\tconst maxScrollTop = Math.max(0, nextItemCount * itemHeight + paddingBottom - nextViewportHeight);'],
    ['\t\t\t\tviewportHeight: nextViewportHeight\n',
      '\t\t\t\tviewportHeight: nextViewportHeight,\n\t\t\t\tpaddingBottom\n'],
    ['const windowHeight = layoutSnapshot.window.height;',
      'const windowHeight = layoutSnapshot.window.height + (layoutSnapshot.window.endIndex === layoutSnapshot.physical.totalRowCount - 1 ? Math.max(0, totalScrollableHeight - layoutSnapshot.physical.totalRowCount * itemHeight) : 0);'],
  ]],
];

// Validate every hunk before writing either file; safe to run again after install.
const updates = patches.map(([path, replacements]) => {
  const file = new URL(path, root);
  let source = readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error(`Cannot apply trees scroll padding patch to ${path}.`);
    source = source.replace(before, after);
  }
  return { file, source };
});
for (const { file, source } of updates) writeFileSync(file, source);
