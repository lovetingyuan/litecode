import { describe, expect, it } from 'vitest';
import { clampScale, formatFileSize, isMarkdownDocument, isMarkdownView, isTextDocument, isTextView, stepScale } from './media';
import type { Doc, Group } from './types';

describe('Media preview behavior', () => {
  it('keeps Markdown text models with preview modes independent for each group', () => {
    const doc = { id: 'readme', kind: 'text', language: 'markdown' } as Doc;
    const group = { mediaViews: { readme: { mode: 'markdown' } } } as unknown as Group;
    expect(isMarkdownDocument(doc)).toBe(true);
    expect(isTextDocument(doc)).toBe(true);
    expect(isTextView(doc)).toBe(true);
    expect(isTextView(doc, group)).toBe(false);
    expect(isMarkdownView(doc, group)).toBe(true);
    expect(isMarkdownView(doc, { mediaViews: { readme: { mode: 'text' } } } as unknown as Group)).toBe(false);
    expect(isMarkdownDocument({ ...doc, kind: 'binary' })).toBe(false);
    expect(isMarkdownView({ ...doc, language: 'plaintext' }, group)).toBe(false);
    expect(isTextView({ ...doc, language: 'plaintext' }, group)).toBe(true);
  });
  it('formats actual byte counts like VS Code', () => {
    expect([0, 500, 1024, 440842, 1048576, 1073741824].map(formatFileSize)).toEqual(['0B', '500B', '1.00KB', '430.51KB', '1.00MB', '1.00GB']);
  });
  it('steps through zoom levels and clamps wheel zoom', () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1.5, -1)).toBe(1);
    expect(stepScale(0.137, 1)).toBe(0.2);
    expect(stepScale(20, 1)).toBe(20);
    expect(stepScale(0.1, -1)).toBe(0.1);
    expect(clampScale(25)).toBe(20);
    expect(clampScale(0.01)).toBe(0.1);
  });
  it('defaults legacy documents to text and SVGs to image with group-local overrides', () => {
    const doc = { id: 'one' } as Doc;
    expect(isTextDocument(doc)).toBe(true);
    expect(isTextView(doc)).toBe(true);
    const svg = { ...doc, kind: 'svg' } as Doc;
    expect(isTextDocument(svg)).toBe(true);
    expect(isTextView(svg)).toBe(false);
    expect(isTextView(svg, { mediaViews: { one: { mode: 'text' } } } as unknown as Group)).toBe(true);
    expect(isTextDocument({ ...doc, kind: 'binary' })).toBe(false);
  });
});
