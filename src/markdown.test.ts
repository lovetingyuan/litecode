import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownHeadingIds, resolveMarkdownUrl } from './markdown';

describe('Markdown resource URLs', () => {
  const path = 'C:\\workspace\\文档 #+\\README.md';
  it('resolves relative files, parent directories and encoded filename delimiters', () => {
    expect(resolveMarkdownUrl('./图片%20%23%2B.png', path)).toEqual({ kind: 'file', path: 'C:/workspace/文档 #+/图片 #+.png', hash: '' });
    expect(resolveMarkdownUrl('../guide.markdown#%E4%B8%AD%E6%96%87', path)).toEqual({ kind: 'file', path: 'C:/workspace/guide.markdown', hash: '中文' });
    expect(resolveMarkdownUrl('..\\guide.md', path)).toMatchObject({ path: 'C:/workspace/guide.md' });
    expect(resolveMarkdownUrl('/images/icon.png', path)).toMatchObject({ path: 'C:/images/icon.png' });
  });
  it('handles absolute Windows, UNC and file URLs without a saved document', () => {
    expect(resolveMarkdownUrl('D:\\images\\中文 #+.png', null)).toMatchObject({ kind: 'file', path: 'D:/images/中文 #+.png' });
    expect(resolveMarkdownUrl('file:///C:/images/a%20b.png', null)).toMatchObject({ path: 'C:/images/a b.png' });
    expect(resolveMarkdownUrl('file://server/share/a.png', null)).toMatchObject({ path: '//server/share/a.png' });
    expect(resolveMarkdownUrl('image.png', null)).toBeUndefined();
  });
  it('distinguishes anchors and external web links', () => {
    expect(resolveMarkdownUrl('#%E4%B8%AD%E6%96%87', path)).toEqual({ kind: 'anchor', hash: '中文' });
    expect(resolveMarkdownUrl('https://example.com/中文', path)).toEqual({ kind: 'external', url: 'https://example.com/%E4%B8%AD%E6%96%87' });
    expect(resolveMarkdownUrl('//example.com/image.png', path)).toEqual({ kind: 'external', url: 'https://example.com/image.png' });
    expect(resolveMarkdownUrl('mailto:hello@example.com', path)).toMatchObject({ kind: 'external' });
  });
  it.each(['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', 'data:text/html,test', 'vbscript:bad', 'command:run', 'https://', '%ZZ', '#%ZZ', ''])('rejects unsafe or malformed URL %j', href => {
    expect(resolveMarkdownUrl(href, path)).toBeUndefined();
  });
});

describe('Markdown rendering', () => {
  const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [markdownHeadingIds], skipHtml: true }, text));
  it('renders GFM and stable unique anchors with Unicode headings', () => {
    const html = render('# 中文 *标题*\n\n## Same\n## Same\n## Same-1\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~\n\n```js\nconst a = 1;\n```');
    expect(html).toContain('id="markdown-中文-标题"');
    for (const id of ['same', 'same-1', 'same-1-1']) {expect(html).toContain(`id="markdown-${id}"`);}
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<pre><code class="language-js">');
  });
  it('ignores raw HTML and never renders executable elements', () => {
    const html = render('hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://example.com"></iframe>\n\n[safe](javascript:alert)');
    expect(html).toContain('hello');
    expect(html).not.toMatch(/<script|<iframe|onerror|javascript:/);
    expect(render('')).toBe('');
  });
});
