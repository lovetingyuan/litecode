import type { ChangeGroup } from "./changes";

export type ChangePane = {
  kind: ChangeGroup;
  count: number;
  expanded: boolean;
  minimum: number;
};
export type PaneWeights = Partial<Record<ChangeGroup, number>>;

export function addPaneWeights(panes: ChangePane[], weights: PaneWeights): PaneWeights {
  const known = panes.filter((pane) => weights[pane.kind] !== undefined);
  const total = known.reduce((sum, pane) => sum + weights[pane.kind]!, 0);
  const count = known.reduce((sum, pane) => sum + pane.count, 0);
  const scale = count && total ? total / count : 1;
  return {
    ...weights,
    ...Object.fromEntries(panes.map((pane) => [
      pane.kind, weights[pane.kind] ?? pane.count * scale,
    ])),
  };
}

export function changePaneSizes(panes: ChangePane[], weights: PaneWeights, height: number): number[] {
  const remaining = Math.max(0, height - panes.reduce((sum, pane) => sum + pane.minimum, 0));
  const expanded = panes.filter((pane) => pane.expanded);
  const total = expanded.reduce((sum, pane) => sum + weights[pane.kind]!, 0);
  return panes.map((pane) => pane.minimum + (pane.expanded
    ? remaining * (total ? weights[pane.kind]! / total : 1 / expanded.length)
    : 0));
}

export function resizedPaneWeights(panes: ChangePane[], weights: PaneWeights, sizes: number[]): PaneWeights {
  const expanded = panes.filter((pane) => pane.expanded);
  const total = expanded.reduce((sum, pane) => sum + weights[pane.kind]!, 0);
  const remaining = panes.map((pane, index) => pane.expanded ? Math.max(0, sizes[index] - pane.minimum) : 0);
  const sum = remaining.reduce((sum, size) => sum + size, 0);
  if (!sum) {
    return weights;
  }
  const next = { ...weights };
  panes.forEach((pane, index) => {
    if (pane.expanded) {
      next[pane.kind] = remaining[index] / sum * (total || expanded.length);
    }
  });
  return next;
}
