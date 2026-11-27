export function parseLocation(value: string) {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?:?$/.exec(value);
  return match
    ? {
        query: match[1],
        line: Math.max(1, Number(match[2])),
        column: Math.max(1, Number(match[3] ?? 1)),
      }
    : { query: value };
}
