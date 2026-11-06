export function validateBranchName(
  name: string,
  windows = typeof navigator !== "undefined" && /Windows/u.test(navigator.userAgent),
): string | undefined {
  if (!name) {
    return "Enter a branch name.";
  }
  if (
    name === "HEAD" ||
    name.startsWith("-") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("@{") ||
    [...name].some(
      (character) => character <= " " || character === "\x7f" || "~^:?*[\\".includes(character),
    ) ||
    name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    return "Invalid branch name.";
  }
  // Git's ref format check does not include Windows filesystem restrictions.
  if (
    windows &&
    (/[<>"|]/u.test(name) ||
      name
        .split("/")
        .some(
          (part) =>
            part.endsWith(".") ||
            /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(part),
        ))
  ) {
    return "Branch names cannot contain Windows reserved names, characters, or segments ending in a dot.";
  }
}
