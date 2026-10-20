import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { errorMessage, mediaSource } from './bridge';
import { models, openPath, patchMediaView } from './documents';
import { markdownHeadingIds, resolveMarkdownUrl } from './markdown';
import { codeLanguage, loadSyntax, monaco } from './monaco';
import { notify, useApp } from './store';
import type { Doc, Group } from './types';
import './MarkdownPreview.css';

export function MarkdownPreview({ doc, group }: { doc: Doc; group: Group }) {
  const host = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(group.mediaViews?.[doc.id]);
  const restoring = useRef(true);
  // Document updates publish to the store; read Monaco as an external snapshot.
  const text = useSyncExternalStore(useApp.subscribe, () => models.get(doc.id)?.getValue() ?? '');
  useLayoutEffect(() => {
    const element = host.current; if (!element) {return;}
    // Nested panes receive their dimensions after their children mount.
    const restore = () => {
      if (!element.clientWidth || !element.clientHeight) {return false;}
      element.scrollTop = savedScroll.current?.scrollTop ?? 0;
      element.scrollLeft = savedScroll.current?.scrollLeft ?? 0;
      restoring.current = false;
      return true;
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (restore()) {observer.disconnect();} });
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={host} className="markdown-preview" tabIndex={0} aria-label={`Markdown preview: ${doc.name}`} onScroll={event => {
    if (!restoring.current) {patchMediaView(group.id, doc.id, { scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft });}
  }}><MarkdownContent text={text} path={doc.path} groupId={group.id} /></div>;
}

const MarkdownContent = memo(function MarkdownContent({ text, path, groupId }: { text: string; path: string | null; groupId: string }) {
  async function follow(href: string, article: HTMLElement) {
    const target = resolveMarkdownUrl(href, path);
    if (!target) {return;}
    if (target.kind === 'external') { await openUrl(target.url); return; }
    if (target.kind === 'file') {
      const editorGroup = article.closest('.editor-group');
      const id = await openPath(target.path, { group: groupId, pinned: true });
      if (target.hash) {patchMediaView(groupId, id, { mode: 'markdown' });}
      // Wait for the destination tab to render before locating its heading.
      requestAnimationFrame(() => {
        const preview = editorGroup?.querySelector<HTMLElement>('.markdown-preview');
        if (preview && target.hash) {jumpToHeading(preview, target.hash);}
      });
      return;
    }
    jumpToHeading(article, target.hash);
  }
  const components: Components = {
    a: ({ href, children, title }) => href ? <a href={href} title={title} onClick={event => {
      event.preventDefault();
      const article = event.currentTarget.closest<HTMLElement>('.markdown-preview');
      if (article) {void follow(href, article).catch(error => notify(errorMessage(error)));}
    }}>{children}</a> : <span>{children}</span>,
    img: ({ src, alt, title }) => <PreviewImage key={typeof src === 'string' ? src : ''} src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
    pre: PreviewCodeBlock,
  };
  return <article className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[markdownHeadingIds]} skipHtml components={components} urlTransform={(url, key) => {
    const target = resolveMarkdownUrl(url, path);
    if (!target) {return '';}
    if (key === 'src') {
      if (target.kind === 'file') {return mediaSource(target.path);}
      return target.kind === 'external' && /^https?:/i.test(target.url) ? target.url : '';
    }
    return target.kind === 'external' ? target.url : url;
  }}>{text}</Markdown></article>;
});

const PreviewCodeBlock: Components['pre'] = ({ node }) => {
  const code = node?.children[0];
  const text = code?.type === 'element' ? code.children.map(child => child.type === 'text' ? child.value : '').join('') : '';
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = Array.isArray(classes) ? String(classes.find(value => String(value).startsWith('language-')) ?? '').slice(9) : '';
  return <PreviewCode key={`${language}:${text}`} text={text} language={language} />;
};

const PreviewCode = memo(function PreviewCode({ text, language }: { text: string; language: string }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    const id = codeLanguage(language);
    if (!id || id === 'plaintext' || !text) {return;}
    let cancelled = false;
    void loadSyntax(id).then(() => monaco.editor.colorize(text.replace(/\n$/, ''), id, { tabSize: 4 })).then(result => {
      if (!cancelled) {setHtml(result);}
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [text, language]);
  return <pre>{html === undefined ? <code>{text}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}</pre>;
});

function jumpToHeading(container: HTMLElement, hash: string) {
  const heading = container.querySelector<HTMLElement>(`#${CSS.escape(`markdown-${hash}`)}`);
  if (!heading) {return;}
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
}

function PreviewImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {return <span className="markdown-image-error" role="img" aria-label={alt || 'Image could not be loaded'}>{alt || 'Image could not be loaded'}</span>;}
  return <img src={src} alt={alt ?? ''} title={title} onError={() => setFailed(true)} />;
}
