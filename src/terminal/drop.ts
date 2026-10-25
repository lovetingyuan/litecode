export function quoteDroppedPaths(paths: string[], shellKind?: string) {
  return paths.map((path) => {
    if (shellKind === "cmd") {
      return `"${path.replace(/\//g, "\\")}"`;
    }
    if (shellKind === "bash") {
      return `'${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    }
    return `'${path.replace(/'/g, "''")}'`;
  }).join(" ");
}
