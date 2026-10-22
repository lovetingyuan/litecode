import { h } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

// A body-level message escapes the virtual scroller and its shadow root.
// Position is read from the input on scroll/resize; no tree row heights change.
export function InlineEditInput({ session, registerInput }) {
  const inputRef = useRef(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !session.error) return;
    const doc = input.ownerDocument;
    const message = doc.createElement("div");
    message.id = `creation-error-${session.name}`;
    message.setAttribute("role", "alert");
    message.dataset.fileTreeCreationError = "true";
    message.dataset.fileTreeEditError = "true";
    message.textContent = session.error;
    Object.assign(message.style, {
      position: "fixed", zIndex: "10000", boxSizing: "border-box", padding: "5px 8px",
      background: "#5a1d1d", color: "#cccccc", border: "1px solid #be1100",
      font: getComputedStyle(input).font, lineHeight: "20px", overflowWrap: "anywhere",
      maxHeight: "calc(100vh - 8px)", overflowY: "auto",
    });
    message.addEventListener("pointerdown", event => event.preventDefault());
    doc.body.append(message);
    // ARIA ID references must live in the same shadow root as the input.
    const description = doc.createElement("span");
    description.id = message.id;
    description.textContent = session.error;
    Object.assign(description.style, { position: "absolute", width: "1px", height: "1px", clipPath: "inset(50%)", overflow: "hidden" });
    input.after(description);
    const host = input.getRootNode().host;
    const scroller = input.getRootNode().querySelector("[data-file-tree-virtualized-scroll]");
    const position = () => {
      const rect = input.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const visible = rect.bottom > view.top && rect.top < view.bottom && rect.width > 0;
      message.style.visibility = visible ? "visible" : "hidden";
      const width = Math.max(1, Math.min(rect.width, doc.documentElement.clientWidth - rect.left - 4));
      message.style.width = `${width}px`;
      message.style.left = `${Math.max(0, rect.left)}px`;
      const height = message.getBoundingClientRect().height;
      const below = Math.min(view.bottom, doc.documentElement.clientHeight) - rect.bottom;
      message.style.top = `${below >= height ? rect.bottom : Math.max(0, rect.top - height)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(host);
    resize.observe(input);
    const changes = new MutationObserver(position);
    changes.observe(scroller, {childList:true, subtree:true, attributes:true, attributeFilter:["style"]});
    scroller.addEventListener("scroll", position);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      changes.disconnect();
      scroller.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      message.remove();
      description.remove();
    };
  }, [session, session.error]);
  return h("input", {
    ref: element => { inputRef.current = element; registerInput(element); },
    "data-item-rename-input": true,
    "data-file-tree-inline-edit-input": true,
    "data-file-tree-creation-input": session.mode === "create" ? true : undefined,
    "data-file-tree-rename-input": session.mode === "rename" ? true : undefined,
    "aria-label": `${session.mode === "rename" ? "Rename " : ""}${session.options.kind === "newFolder" ? "Folder" : "File"} name. Press Enter to confirm or Escape to cancel.`,
    "aria-invalid": !!session.error,
    "aria-describedby": session.error ? `creation-error-${session.name}` : undefined,
    "aria-busy": session.busy,
    style: { borderColor: session.error ? "#be1100" : undefined },
    value: session.value,
    readOnly: session.busy,
    spellcheck: false,
    onInput: event => session.setValue(event.currentTarget.value),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onKeyDown: event => {
      if (event.isComposing || composing.current || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") void session.commit();
        else {
          const shadow = event.currentTarget.getRootNode();
          session.cancel();
          if (session.disposed) requestAnimationFrame(() => shadow.querySelector('[data-item-focused="true"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])')?.focus({ preventScroll: true }));
        }
      }
    },
    onBlur: () => { void session.commit(true); },
    onClick: event => event.stopPropagation(),
    onMouseDown: event => event.stopPropagation(),
    onPointerDown: event => event.stopPropagation(),
    onContextMenu: event => event.stopPropagation(),
  });
}
