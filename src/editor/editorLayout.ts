export type SplitDirection = "left" | "right" | "up" | "down";
export type EditorLayout = { type: "group"; id: string } | EditorSplit;
export type EditorSplit = {
  type: "split";
  id: string;
  axis: "horizontal" | "vertical";
  children: EditorLayout[];
  sizes: number[];
};

export const layoutGroups = (node: EditorLayout): string[] =>
  node.type === "group" ? [node.id] : node.children.flatMap(layoutGroups);
const equalSizes = (sizes: number[]) => Math.max(...sizes) - Math.min(...sizes) <= 2;
const total = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);

function branch(
  children: EditorLayout[],
  axis: EditorSplit["axis"],
  sizes = children.map(() => 1),
): EditorLayout {
  return children.length === 1
    ? children[0]
    : { type: "split", id: crypto.randomUUID(), axis, children, sizes };
}

// Session data is untrusted. Keep every recovered group even if its layout is stale.
export function restoreLayout(value: unknown, groups: string[]): EditorLayout {
  const seen = new Set<string>();
  const splitIds = new Set<string>();
  function read(value: unknown, depth: number): EditorLayout | null {
    if (!value || typeof value !== "object" || depth > 100) {
      return null;
    }
    const node = value as {
      type?: string;
      id?: string;
      axis?: EditorSplit["axis"];
      children?: unknown[];
      sizes?: number[];
    };
    if (
      node.type === "group" &&
      typeof node.id === "string" &&
      groups.includes(node.id) &&
      !seen.has(node.id)
    ) {
      seen.add(node.id);
      return { type: "group", id: node.id };
    }
    if (
      node.type !== "split" ||
      !Array.isArray(node.children) ||
      !["horizontal", "vertical"].includes(node.axis!)
    ) {
      return null;
    }
    const sizes: number[] = [];
    const children = node.children.flatMap((child, i) => {
      const restored = read(child, depth + 1);
      if (!restored) {
        return [];
      }
      const size = node.sizes?.[i];
      sizes.push(typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 1);
      return [restored];
    });
    if (!children.length) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    const id =
      typeof node.id === "string" && !splitIds.has(node.id) ? node.id : crypto.randomUUID();
    splitIds.add(id);
    return { type: "split", id, axis: node.axis!, children, sizes };
  }
  const restored = read(value, 0);
  const missing = groups
    .filter((id) => !seen.has(id))
    .map((id) => ({ type: "group" as const, id }));
  if (!restored) {
    return branch(missing, "horizontal");
  }
  if (!missing.length) {
    return restored;
  }
  if (restored.type === "split" && restored.axis === "horizontal") {
    return {
      ...restored,
      children: [...restored.children, ...missing],
      sizes: [
        ...restored.sizes,
        ...missing.map(() => total(restored.sizes) / restored.sizes.length),
      ],
    };
  }
  return branch([restored, ...missing], "horizontal");
}

export function splitLayout(
  node: EditorLayout,
  source: string,
  id: string,
  direction: SplitDirection,
): EditorLayout {
  const axis = direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const before = direction === "left" || direction === "up";
  const leaf: EditorLayout = { type: "group", id };
  if (node.type === "group") {
    return node.id !== source ? node : branch(before ? [leaf, node] : [node, leaf], axis);
  }
  const index = node.children.findIndex((child) => child.type === "group" && child.id === source);
  if (node.axis === axis && index >= 0) {
    const children = [...node.children];
    children.splice(index + (before ? 0 : 1), 0, leaf);
    const sizes = [...node.sizes];
    if (equalSizes(sizes)) {
      sizes.splice(0, sizes.length, ...children.map(() => total(node.sizes) / children.length));
    } else {
      sizes[index] /= 2;
      sizes.splice(index + (before ? 0 : 1), 0, sizes[index]);
    }
    return { ...node, children, sizes };
  }
  return {
    ...node,
    children: node.children.map((child) => splitLayout(child, source, id, direction)),
  };
}

export function removeLayoutGroup(node: EditorLayout, id: string): EditorLayout | null {
  if (node.type === "group") {
    return node.id === id ? null : node;
  }
  const sizes = [...node.sizes];
  const children: EditorLayout[] = [];
  let removed = -1;
  node.children.forEach((child, i) => {
    const next = removeLayoutGroup(child, id);
    if (next) {
      children.push(next);
    } else {
      removed = i;
    }
  });
  if (!children.length) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }
  if (removed >= 0) {
    const size = sizes.splice(removed, 1)[0];
    if (equalSizes(node.sizes)) {
      sizes.fill(total(node.sizes) / children.length);
    } else {
      sizes[Math.min(removed, sizes.length - 1)] += size;
    }
  }
  // Removing a nested split may expose children with the same orientation.
  const flat: EditorLayout[] = [],
    weights: number[] = [];
  children.forEach((child, i) => {
    if (child.type === "split" && child.axis === node.axis) {
      flat.push(...child.children);
      weights.push(...child.sizes.map((size) => (size / total(child.sizes)) * sizes[i]));
    } else {
      flat.push(child);
      weights.push(sizes[i]);
    }
  });
  return { ...node, children: flat, sizes: weights };
}

export function resizeLayout(node: EditorLayout, id: string, sizes: number[]): EditorLayout {
  if (node.type === "group") {
    return node;
  }
  if (node.id === id) {
    return sizes.length === node.children.length && sizes.every((n) => Number.isFinite(n) && n > 0)
      ? { ...node, sizes }
      : node;
  }
  return { ...node, children: node.children.map((child) => resizeLayout(child, id, sizes)) };
}

export function minimumLayoutSize(node: EditorLayout): { width: number; height: number } {
  if (node.type === "group") {
    return { width: 160, height: 120 };
  }
  const sizes = node.children.map(minimumLayoutSize);
  return {
    width:
      node.axis === "horizontal"
        ? total(sizes.map((s) => s.width))
        : Math.max(...sizes.map((s) => s.width)),
    height:
      node.axis === "vertical"
        ? total(sizes.map((s) => s.height))
        : Math.max(...sizes.map((s) => s.height)),
  };
}
