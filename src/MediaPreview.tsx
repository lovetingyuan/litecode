import { useEffect, useRef, useState } from 'react';
import { mediaSource } from './bridge';
import { models, patchDoc, patchMediaView } from './documents';
import { clampScale, stepScale } from './media';
import { Icon } from './ui';
import type { Doc, Group } from './types';
import './MediaPreview.css';
import { useApp } from './store';

export function MediaPreview({ doc, group }: { doc: Doc; group: Group }) {
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState('');
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  const activeGroup = useApp(s => s.activeGroup);
  const deleted = !!doc.deleted;
  const svgText = doc.kind === 'svg' ? models.get(doc.id)?.getValue() : undefined;
  useEffect(() => {
    setError(false); setReady(false);
    if (deleted || doc.kind === 'binary' || !doc.path) { setSource(''); return; }
    if (svgText !== undefined) {
      const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      setSource(url);
      return () => URL.revokeObjectURL(url);
    }
    setSource(`${mediaSource(doc.path)}?v=${encodeURIComponent(doc.fileInfo?.stamp ?? '')}&retry=${retry}`);
  }, [doc.path, doc.kind, deleted, doc.fileInfo?.stamp, svgText, retry]);
  useEffect(() => {
    const media = player.current;
    return () => { if (media) { media.pause(); media.removeAttribute('src'); media.load(); } };
  }, [source]);
  useEffect(() => { if (activeGroup !== group.id) player.current?.pause(); }, [activeGroup, group.id]);
  const failure = () => { setError(true); setReady(false); patchDoc(doc.id, { imageSize: undefined }); };
  let content;
  if (doc.deleted) content = <div className="media-message" role="status"><Icon name="warning" /><p>The file could not be found. It may have been moved or deleted.</p></div>;
  else if (doc.kind === 'binary') content = <div className="media-message binary-message" role="status"><Icon name="warning" /><p>The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.</p></div>;
  else if (error) content = <div className="media-message" role="alert"><Icon name="warning" /><p>An error occurred while loading the {doc.kind === 'svg' ? 'image' : doc.kind} file.</p><button className="media-retry" onClick={() => setRetry(value => value + 1)}>Retry</button></div>;
  else content = <>
    {!ready && <div className="media-loading" role="status"><span className="spinner" /><span>Loading preview…</span></div>}
    {source && (doc.kind === 'image' || doc.kind === 'svg' ? <ImagePreview key={source} doc={doc} group={group} source={source} onReady={() => setReady(true)} onError={failure} />
      : doc.kind === 'video' ? <video key={source} ref={element => { player.current = element; }} src={source} controls preload="metadata" aria-label={`Video preview: ${doc.name}`} onLoadedMetadata={() => setReady(true)} onError={failure} />
      : <audio key={source} ref={element => { player.current = element; }} src={source} controls preload="metadata" aria-label={`Audio preview: ${doc.name}`} onLoadedMetadata={() => setReady(true)} onError={failure} />)}
  </>;
  return <div className={`media-preview ${doc.kind === 'video' || doc.kind === 'audio' ? 'playback-preview' : ''}`} tabIndex={0} aria-label={`Preview of ${doc.name}`}>{content}</div>;
}

function ImagePreview({ doc, group, source, onReady, onError }: { doc: Doc; group: Group; source: string; onReady(): void; onError(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const view = group.mediaViews?.[doc.id];
  const scale = view?.scale ?? 'fit';
  const fitted = natural ? Math.min(1, Math.max(0, viewport.width - 32) / natural.width, Math.max(0, viewport.height - 32) / natural.height) : 1;
  const actual = scale === 'fit' ? fitted : clampScale(scale);
  const zoomRef = useRef({ actual, groupId: group.id, id: doc.id });
  zoomRef.current = { actual, groupId: group.id, id: doc.id };
  const savedScroll = useRef({ left: view?.scrollLeft ?? 0, top: view?.scrollTop ?? 0 });
  const restoring = useRef(true);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      const current = zoomRef.current;
      patchMediaView(current.groupId, current.id, { scale: clampScale(current.actual * (event.deltaY > 0 ? 0.925 : 1.075)) });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);
  useEffect(() => {
    if (!natural || !viewport.width || !host.current || !restoring.current) return;
    host.current.scrollLeft = savedScroll.current.left; host.current.scrollTop = savedScroll.current.top;
    restoring.current = false;
  }, [natural, viewport]);
  function zoom(direction: number) { patchMediaView(group.id, doc.id, { scale: stepScale(actual, direction) }); }
  return <div ref={host} className="image-viewport" tabIndex={0} aria-label="Image preview, Ctrl+scroll or click to zoom" onScroll={event => {
    if (!restoring.current) patchMediaView(group.id, doc.id, { scrollLeft: event.currentTarget.scrollLeft, scrollTop: event.currentTarget.scrollTop });
  }} onKeyDown={event => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1); }
    if (event.key === '-') { event.preventDefault(); zoom(-1); }
    if (event.key === '0') { event.preventDefault(); patchMediaView(group.id, doc.id, { scale: 1 }); }
  }}>
    <div className="image-stage" style={natural ? { width: natural.width * actual + 32, height: natural.height * actual + 32 } : undefined}>
      <img src={source} alt={doc.name} draggable={false} className={actual >= 3 ? 'pixelated' : ''} style={natural ? { width: natural.width * actual, height: natural.height * actual } : { visibility: 'hidden' }}
        onClick={event => { host.current?.focus({ preventScroll: true }); zoom(event.ctrlKey ? -1 : 1); }} onLoad={event => {
          const img = event.currentTarget;
          let width = img.naturalWidth; let height = img.naturalHeight;
          if ((!width || !height) && doc.kind === 'svg') {
            const svg = new DOMParser().parseFromString(models.get(doc.id)?.getValue() ?? '', 'image/svg+xml').documentElement;
            const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
            if (box?.length === 4) { width = box[2]; height = box[3]; }
          }
          if (!(width > 0 && height > 0)) { onError(); return; }
          setNatural({ width, height }); patchDoc(doc.id, { imageSize: { width, height } }); onReady();
        }} onError={onError} />
    </div>
  </div>;
}
