import { parse, type IExpression } from '@codingame/monaco-vscode-api/vscode/vs/base/common/glob';
import schema from './settings-schema.json';

function rules(value: unknown): IExpression {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return {};}
  return Object.fromEntries(Object.entries(value).filter(([, rule]) => typeof rule === 'boolean' || (rule && typeof rule === 'object' && typeof rule.when === 'string')));
}

// Only changes to search inputs should rebuild the file index.
export function quickFileSettingsKey(settings: Record<string, unknown>): string {
  return JSON.stringify({
    excludes: {
      ...schema.properties['files.exclude'].default, ...rules(settings['files.exclude']),
      ...schema.properties['search.exclude'].default, ...rules(settings['search.exclude']),
    },
    useIgnoreFiles: settings['search.useIgnoreFiles'] !== false,
    useGlobalIgnoreFiles: settings['search.useGlobalIgnoreFiles'] === true,
    useParentIgnoreFiles: settings['search.useParentIgnoreFiles'] === true,
    followSymlinks: settings['search.followSymlinks'] !== false,
  });
}

const visibleQuickPath = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^[A-Z]:/, drive => drive.toLowerCase());

export function filterQuickFiles(paths: string[], excludes: IExpression, workspace: boolean, root: string | null = null): string[] {
  const expression = Object.fromEntries(Object.entries(rules(excludes)).map(([pattern, rule]) => [visibleQuickPath(pattern), rule]));
  const match = parse(expression);
  const hasAbsolute = Object.keys(expression).some(pattern => /^(?:[a-z]:\/|\/)/i.test(pattern));
  const base = root ? visibleQuickPath(root).replace(/\/$/, '') + '/' : null;
  const relative = (path: string) => {
    if (workspace || !base) {return path;}
    const within = /^(?:[a-z]:\/|\/\/)/i.test(base) ? path.toLowerCase().startsWith(base.toLowerCase()) : path.startsWith(base);
    return within ? path.slice(base.length) : path;
  };
  const siblings = new Set<string>();
  if (Object.values(expression).some(rule => typeof rule === 'object')) {
    for (const path of paths) {
      let value = visibleQuickPath(path);
      while (value) {
        siblings.add(value);
        siblings.add(relative(value));
        if (workspace && base) {siblings.add(base + value);}
        const slash = value.lastIndexOf('/');
        if (slash < 0) {break;}
        value = value.slice(0, slash);
      }
    }
  }
  const excluded = (path: string) => {
    const slash = path.lastIndexOf('/');
    return !!match(path, path.slice(slash + 1), name => siblings.has(path.slice(0, slash + 1) + name));
  };
  return paths.filter(path => {
    const absolute = visibleQuickPath(path);
    let value = relative(absolute);
    if (excluded(value) || (hasAbsolute && excluded(workspace && base ? base + value : absolute))) {return false;}
    // Only workspace traversal inherits excluded directories; opened files match directly.
    if (workspace) {
      for (let slash = value.lastIndexOf('/'); slash >= 0; slash = value.lastIndexOf('/')) {
        value = value.slice(0, slash);
        if (excluded(value) || (hasAbsolute && base && excluded(base + value))) {return false;}
      }
    }
    return true;
  });
}
