import { describe, expect, it } from "vitest";
import { addPaneWeights, changePaneSizes, resizedPaneWeights, type ChangePane } from "./panes";

const panes: ChangePane[] = [
  { kind: "staged", count: 27, expanded: true, minimum: 54 },
  { kind: "changes", count: 6, expanded: true, minimum: 54 },
  { kind: "untracked", count: 9, expanded: true, minimum: 54 },
];

describe("Git change panes", () => {
  it("allocates remaining height by file count and keeps every group usable", () => {
    const weights = addPaneWeights(panes, {});
    const sizes = changePaneSizes(panes, weights, 582);
    expect(sizes).toEqual([324, 114, 144]);
    expect(changePaneSizes(panes, weights, 100)).toEqual([54, 54, 54]);
  });

  it("preserves a manual resize through file refresh, collapse and expansion", () => {
    const weights = resizedPaneWeights(panes, addPaneWeights(panes, {}), [204, 164, 214]);
    expect(changePaneSizes(panes, weights, 582)).toEqual([204, 164, 214]);
    const refreshed = panes.map((pane) => ({ ...pane, count: 100 }));
    expect(addPaneWeights(refreshed, weights)).toEqual(weights);
    const collapsed = panes.map((pane, index) => index === 0 ? { ...pane, expanded: false, minimum: 28 } : pane);
    const sizes = changePaneSizes(collapsed, weights, 582);
    expect(sizes[0]).toBe(28);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(582);
    expect(changePaneSizes(panes, weights, 582)).toEqual([204, 164, 214]);
  });

  it("gives a newly appearing group its count-based share without changing existing proportions", () => {
    const weights = { staged: 3, changes: 1 };
    const next = addPaneWeights(panes, weights);
    expect(next.staged! / next.changes!).toBe(3);
    expect(next.untracked! / (next.staged! + next.changes! + next.untracked!)).toBeCloseTo(9 / 42);
  });

  it("retains a collapsed pane's weight while resizing the other panes", () => {
    const weights = addPaneWeights(panes, {});
    const collapsed = panes.map((pane, index) => index === 0 ? { ...pane, expanded: false, minimum: 28 } : pane);
    const next = resizedPaneWeights(collapsed, weights, [28, 200, 354]);
    expect(next.staged).toBe(27);
    expect(next.changes! + next.untracked!).toBeCloseTo(15);
    expect(changePaneSizes(panes, next, 582)[0]).toBe(324);
  });

  it("handles all panes collapsed, minimum heights, and a tree selection toolbar", () => {
    const weights = addPaneWeights(panes, {});
    const collapsed = panes.map((pane) => ({ ...pane, expanded: false, minimum: 28 }));
    expect(changePaneSizes(collapsed, weights, 582)).toEqual([28, 28, 28]);
    expect(resizedPaneWeights(panes, weights, [54, 54, 54])).toEqual(weights);
    const tree = panes.map((pane, index) => ({ ...pane, minimum: index === 0 ? 82 : 54 }));
    expect(changePaneSizes(tree, weights, 100)).toEqual([82, 54, 54]);
    expect(changePaneSizes(panes, { staged: 0, changes: 0, untracked: 0 }, 582)).toEqual([194, 194, 194]);
  });
});
