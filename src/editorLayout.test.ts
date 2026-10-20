import { describe, expect, it } from 'vitest';
import { layoutGroups, minimumLayoutSize, removeLayoutGroup, restoreLayout, splitLayout, type EditorLayout, type EditorSplit } from './editorLayout';

const leaf = (id: string): EditorLayout => ({ type: 'group', id });
const row = (sizes: number[]): EditorSplit => ({ type: 'split', id: 'row', axis: 'horizontal', children: sizes.map((_, i) => leaf(String(i))), sizes });

describe('Editor layout', () => {
  it.each(['left', 'right', 'up', 'down'] as const)('inserts a group %s of its source', direction => {
    const layout = splitLayout(leaf('a'), 'a', 'b', direction) as EditorSplit;
    expect(layout.axis).toBe(['left', 'right'].includes(direction) ? 'horizontal' : 'vertical');
    expect(layoutGroups(layout)).toEqual(['left', 'up'].includes(direction) ? ['b', 'a'] : ['a', 'b']);
    expect(layout.sizes).toEqual([1, 1]);
  });
  it('distributes a third column when sizes differ by at most two pixels', () => {
    const layout = splitLayout(row([501, 499]), '1', 'new', 'right') as EditorSplit;
    expect(layoutGroups(layout)).toEqual(['0', '1', 'new']);
    expect(layout.sizes).toEqual([1000 / 3, 1000 / 3, 1000 / 3]);
  });
  it('only splits the target column after manual resizing', () => {
    const layout = splitLayout(row([600, 400]), '0', 'new', 'left') as EditorSplit;
    expect(layoutGroups(layout)).toEqual(['new', '0', '1']);
    expect(layout.sizes).toEqual([300, 300, 400]);
  });
  it('nests perpendicular splits and propagates minimum sizes', () => {
    const layout = splitLayout(row([500, 500]), '1', 'new', 'down') as EditorSplit;
    expect(layout.children[1]).toMatchObject({ type: 'split', axis: 'vertical', children: [leaf('1'), leaf('new')] });
    expect(layout.sizes).toEqual([500, 500]);
    expect(minimumLayoutSize(layout)).toEqual({ width: 320, height: 240 });
    expect(removeLayoutGroup(layout, 'new')).toEqual(row([500, 500]));
  });
  it('redistributes equal siblings but preserves unequal siblings on removal', () => {
    expect((removeLayoutGroup(row([300, 300, 300]), '1') as EditorSplit).sizes).toEqual([450, 450]);
    expect((removeLayoutGroup(row([200, 300, 400]), '1') as EditorSplit).sizes).toEqual([200, 700]);
    expect(removeLayoutGroup(leaf('last'), 'last')).toBeNull();
  });
  it('flattens a promoted split of the same orientation without changing its proportions', () => {
    let layout = splitLayout(row([500, 500]), '1', 'bottom', 'down');
    layout = splitLayout(layout, '1', 'right', 'right');
    const removed = removeLayoutGroup(layout, 'bottom') as EditorSplit;
    expect(layoutGroups(removed)).toEqual(['0', '1', 'right']);
    expect(removed.sizes).toEqual([500, 250, 250]);
  });
  it('migrates legacy sessions, repairs stale layouts and keeps every recovered group', () => {
    expect(layoutGroups(restoreLayout(undefined, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
    const bad = { type: 'split', axis: 'horizontal', children: [leaf('a'), leaf('a'), leaf('missing')], sizes: [NaN, -1, 2] };
    const repaired = restoreLayout(bad, ['a', 'b']);
    expect(layoutGroups(repaired)).toEqual(['a', 'b']);
    expect(repaired).toMatchObject({ sizes: [1, 1] });
    expect(restoreLayout({ type: 'split', children: 'invalid' }, ['a'])).toEqual(leaf('a'));
  });
  it('round-trips nested sizes and repairs invalid weights', () => {
    const layout = splitLayout(row([600, 400]), '1', 'new', 'up');
    expect(restoreLayout(JSON.parse(JSON.stringify(layout)), layoutGroups(layout))).toEqual(layout);
    expect(restoreLayout({ ...row([Infinity, 0]), id: undefined }, ['0', '1'])).toMatchObject({ sizes: [1, 1] });
  });
});
