export type MarkdownTarget = { kind: 'anchor'; hash: string } | { kind: 'external'; url: string } | { kind: 'file'; path: string; hash: string };

function fileUrl(path: string) {
  const normalized = path.replace(/\\/g, '/');
  // Encode filename delimiters before constructing the base URL.
  const encoded = normalized.split('/').map((segment, index) => index === 0 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment)).join('/');
  return new URL(normalized.startsWith('//') ? `file:${encoded}` : `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`);
}

export function resolveMarkdownUrl(value: string, documentPath: string | null): MarkdownTarget | undefined {
  const href = value.trim();
  // oxlint-disable-next-line no-control-regex -- Reject control characters before URL normalization can discard them.
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) {return;}
  try {
    if (href.startsWith('#')) {return { kind: 'anchor', hash: decodeURIComponent(href.slice(1)) };}
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
      const url = new URL(href, 'https://localhost');
      return { kind: 'external', url: url.href };
    }
    const absolute = /^[a-z]:[\\/]/i.test(href);
    if (!absolute && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) {return;}
    if (!absolute && !/^file:/i.test(href) && !documentPath) {return;}
    const url = absolute ? fileUrl(href) : new URL(href.replace(/\\/g, '/'), documentPath ? fileUrl(documentPath) : undefined);
    if (url.protocol !== 'file:') {return;}
    const pathname = decodeURIComponent(url.pathname);
    const path = url.hostname ? `//${url.hostname}${pathname}` : pathname.replace(/^\/([a-z]:\/)/i, '$1');
    return { kind: 'file', path, hash: decodeURIComponent(url.hash.slice(1)) };
  } catch { return; }
}

type MarkdownNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };
const nodeText = (node: MarkdownNode): string => node.value ?? node.children?.map(nodeText).join('') ?? '';

// Prefix IDs to keep document headings separate from workbench DOM IDs.
export function markdownHeadingIds() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    function visit(node: MarkdownNode) {
      if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const slug = nodeText(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-');
        let id = slug; let suffix = 0;
        while (used.has(id)) {id = `${slug}-${++suffix}`;}
        used.add(id);
        node.properties = { ...node.properties, id: `markdown-${id}` };
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
