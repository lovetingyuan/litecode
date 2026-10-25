import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Allotment, LayoutPriority, type AllotmentHandle, type AllotmentProps } from "allotment";
import "allotment/dist/style.css";
import { EditorGroup } from "./EditorGroup";
import {
  minimumLayoutSize,
  resizeLayout,
  type EditorLayout,
  type EditorSplit,
} from "../editor/editorLayout";
import { useApp, setApp } from "../store/store";
import { scheduleBackup } from "../editor/documents";

// Allotment owns dragging. Add keyboard access and balance only the clicked pair.
export function PaneLayout({
  children,
  label,
  onChange,
  onCommit = scheduleBackup,
  ...props
}: AllotmentProps & { label: string; onCommit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<AllotmentHandle>(null);
  const sizes = useRef<number[]>(props.defaultSizes ?? []);
  const mounted = useRef(false);
  function sashes() {
    return Array.from(host.current?.querySelectorAll<HTMLElement>(".sash") ?? []).filter(
      (el) => el.closest(".pane-layout") === host.current,
    );
  }
  function describe() {
    sashes().forEach((el, index) => {
      el.tabIndex = el.classList.contains("sash-disabled") ? -1 : 0;
      el.setAttribute("role", "separator");
      el.setAttribute("aria-label", label);
      el.setAttribute("aria-orientation", props.vertical ? "horizontal" : "vertical");
      el.setAttribute("aria-valuenow", String(Math.round(sizes.current[index] ?? 0)));
    });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    describe();
    if (sizes.current.some((n) => n > 0)) {
      onChange?.(sizes.current);
    }
    return () => {
      mounted.current = false;
    };
    // oxlint-disable-next-line react/exhaustive-deps -- Publish initial sizes only on mount; later changes are handled by Allotment's onChange.
  }, []);
  function indexOf(target: EventTarget | null) {
    return sashes().indexOf((target as HTMLElement).closest<HTMLElement>(".sash")!);
  }
  return (
    <div
      ref={host}
      className="pane-layout"
      onDoubleClickCapture={(event) => {
        const index = indexOf(event.target);
        if (index < 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const next = [...sizes.current];
        const half = (next[index] + next[index + 1]) / 2;
        next[index] = half;
        next[index + 1] = half;
        handle.current?.resize(next);
        onCommit();
      }}
      onKeyDown={(event) => {
        const index = indexOf(event.target);
        if (index < 0) {
          return;
        }
        const backward = props.vertical ? "ArrowUp" : "ArrowLeft",
          forward = props.vertical ? "ArrowDown" : "ArrowRight";
        if (event.key !== backward && event.key !== forward) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === forward ? 10 : -10;
        const next = [...sizes.current];
        next[index] += delta;
        next[index + 1] -= delta;
        handle.current?.resize(next);
        onCommit();
      }}
    >
      <Allotment
        {...props}
        ref={handle}
        onChange={(next) => {
          sizes.current = next;
          if (mounted.current) {
            describe();
            onChange?.(next);
          }
        }}
        onDragEnd={onCommit}
      >
        {children}
      </Allotment>
    </div>
  );
}

export function EditorLayoutView({ node }: { node: EditorLayout }) {
  const group = useApp((s) =>
    node.type === "group" ? s.groups.find((g) => g.id === node.id) : undefined,
  );
  if (node.type === "group") {
    return group ? <EditorGroup group={group} /> : null;
  }
  // A changed ancestry can recreate editors; document operations save views first.
  return (
    <EditorSplitView
      key={`${node.id}:${node.axis}:${node.children.map((child) => child.id).join(",")}`}
      node={node}
    />
  );
}

function EditorSplitView({ node }: { node: EditorSplit }) {
  return (
    <PaneLayout
      vertical={node.axis === "vertical"}
      defaultSizes={node.sizes}
      label="Editor group size"
      onChange={(sizes) => {
        setApp((s) => ({
          editorLayout: s.editorLayout && resizeLayout(s.editorLayout, node.id, sizes),
        }));
        scheduleBackup();
      }}
    >
      {node.children.map((child) => {
        const minimum = minimumLayoutSize(child);
        return (
          <Allotment.Pane
            key={child.id}
            minSize={node.axis === "vertical" ? minimum.height : minimum.width}
          >
            <EditorLayoutView node={child} />
          </Allotment.Pane>
        );
      })}
    </PaneLayout>
  );
}

export function WorkbenchLayout({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const visible = useApp((s) => !!s.sidebar && s.view === "editor");
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const layout = useApp((s) => s.editorLayout);
  const terminal = useApp((s) => s.view === "terminal");
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth - 48);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    if (host.current) {
      observer.observe(host.current);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="workbench-layout">
      <PaneLayout
        label="Primary side bar width"
        proportionalLayout={false}
        defaultSizes={[sidebarWidth, Math.max(160, width - sidebarWidth)]}
        onChange={(sizes) => {
          if (
            useApp.getState().sidebar &&
            useApp.getState().view === "editor" &&
            sizes[0] >= 170
          ) {
            setApp({ sidebarWidth: sizes[0] });
            scheduleBackup();
          }
        }}
      >
        <Allotment.Pane
          minSize={170}
          maxSize={Math.max(170, width * 0.65)}
          preferredSize={sidebarWidth}
          visible={visible}
          priority={LayoutPriority.Low}
        >
          {sidebar}
        </Allotment.Pane>
        <Allotment.Pane
          minSize={
            terminal ? 160 : layout ? minimumLayoutSize(layout).width : 160
          }
          priority={LayoutPriority.High}
        >
          {children}
        </Allotment.Pane>
      </PaneLayout>
    </div>
  );
}
