import type { Keybinding } from './types';

export function normalizeKey(value: string) {
  return value.trim().split(/\s+/).map(part => {
    const pieces = part.toLowerCase().split('+');
    const key = pieces.pop() ?? '';
    return [...['ctrl', 'shift', 'alt', 'meta'].filter(mod => pieces.includes(mod)), key.replace(/^arrow/, '')].join('+');
  }).join(' ');
}

// A deliberately bounded expression grammar; configuration is never executable code.
export function matchesWhen(expression: string | undefined, context: Record<string, string | boolean>): boolean {
  if (!expression?.trim()) {return true;}
  const tokens = expression.match(/\s*(===|!==|==|!=|&&|\|\||!|\(|\)|'[^']*'|"[^"]*"|[\w.:-]+)\s*/g)?.map(t => t.trim()) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) {return false;}
  let i = 0;
  const atom = (): boolean => {
    if (tokens[i] === '!') { i++; return !atom(); }
    if (tokens[i] === '(') { i++; const result = or(); if (tokens[i++] !== ')') {throw new Error('Unclosed context');} return result; }
    const name = tokens[i++]; if (!name) {throw new Error('Missing context');}
    const actual = name === 'true' ? true : name === 'false' ? false : context[name] ?? false;
    if (['==', '===', '!=', '!=='].includes(tokens[i])) {
      const operator = tokens[i++]; const expected = tokens[i++]; if (!expected) {throw new Error('Missing comparison');}
      const equal = String(actual) === expected.replace(/^['"]|['"]$/g, '');
      return operator.startsWith('!') ? !equal : equal;
    }
    return !!actual;
  };
  const and = (): boolean => { let value = atom(); while (tokens[i] === '&&') { i++; const next = atom(); value = value && next; } return value; };
  const or = (): boolean => { let value = and(); while (tokens[i] === '||') { i++; const next = and(); value = value || next; } return value; };
  try { const result = or(); return i === tokens.length && result; } catch { return false; }
}

export function resolveBinding(bindings: Keybinding[], key: string, context: Record<string, string | boolean>) {
  const normalized = normalizeKey(key);
  const active = bindings.filter(b => typeof b?.key === 'string' && typeof b.command === 'string' && matchesWhen(b.when, context));
  const removed = new Set(active.filter(b => b.command.startsWith('-') && normalizeKey(b.key) === normalized).map(b => b.command.slice(1)));
  return { command: [...active].reverse().find(b => normalizeKey(b.key) === normalized && !b.command.startsWith('-') && !removed.has(b.command))?.command,
    removed, prefix: active.some(b => !b.command.startsWith('-') && normalizeKey(b.key).startsWith(`${normalized} `)) };
}
