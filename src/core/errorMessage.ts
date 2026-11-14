const stackFrame = /^[ \t]*(?:at[ \t]+|traceback \(|stack backtrace:)/im;
const browserStackFrame = /^\w*@(?:file:|https?:)/m;

export function stripErrorStack(message: string): string {
  const frame = message.search(stackFrame);
  const browserFrame = message.search(browserStackFrame);
  const end = Math.min(
    frame === -1 ? message.length : frame,
    browserFrame === -1 ? message.length : browserFrame,
  );
  return message.slice(0, end).trim();
}

export function errorMessage(error: unknown, fallback = "The operation failed."): string {
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;

  const firstLine =
    typeof message === "string"
      ? stripErrorStack(
          message
            .trimStart()
            .split(/[\r\n\u2028\u2029]/, 1)[0]
            ?.replace(/^(?:\w*Error|Exception)(?: \[[\w-]+\])?:\s*/i, "") ?? "",
        )
      : "";
  if (firstLine && firstLine.length <= 200) {
    return firstLine;
  }
  return Number.isInteger(code) || (typeof code === "string" && /^[\w-]{1,32}$/.test(code))
    ? `${fallback} (${code})`
    : fallback;
}
