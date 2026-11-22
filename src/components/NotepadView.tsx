import notepadStyles from "../styles/notepad.module.css";
import { useEffect, useRef, useState } from "react";
import { Allotment, LayoutPriority } from "allotment";
import { PaneLayout } from "./EditorGrid";
import { NotepadSidebar } from "./NotepadSidebar";
import { NotepadEditor } from "./NotepadEditor";
import { useApp, notify } from "../store/store";
import { errorMessage } from "../core/bridge";
import { ensureNotepadLoaded, flushNotepadSaves } from "../notepad/runtime";
import { useNotepad } from "../notepad/state";

const noCommit = () => {};

export default function NotepadView() {
  const visible = useApp((s) => s.view === "notepad");
  const loaded = useNotepad((s) => s.loaded);
  const sidebarOpen = useNotepad((s) => s.sidebarOpen);
  const sidebarWidth = useNotepad((s) => s.sidebarWidth);
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth - 48);

  useEffect(() => {
    void ensureNotepadLoaded().catch((error) => notify(errorMessage(error)));
    return () => {
      void flushNotepadSaves();
    };
  }, []);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={hostRef}
      className={`notepad-view flex flex-1 relative w-full h-full min-w-0 min-h-0 bg-editor text-foreground overflow-hidden ${notepadStyles["notepad-view"]}`}
      aria-label="Notepad"
      hidden={!visible}
    >
      {loaded ? (
        <PaneLayout
          label="Notepad notes list width"
          separator={sidebarOpen}
          proportionalLayout={false}
          defaultSizes={[sidebarWidth, Math.max(240, width - sidebarWidth)]}
          onCommit={noCommit}
          onChange={(sizes) => {
            if (useNotepad.getState().sidebarOpen && sizes[0] >= 170) {
              useNotepad.setState({ sidebarWidth: sizes[0] });
            }
          }}
        >
          <Allotment.Pane
            minSize={170}
            maxSize={Math.max(220, width * 0.45)}
            preferredSize={sidebarWidth}
            visible={sidebarOpen}
            priority={LayoutPriority.Low}
          >
            <NotepadSidebar />
          </Allotment.Pane>
          <Allotment.Pane minSize={240} priority={LayoutPriority.High}>
            <NotepadEditor />
          </Allotment.Pane>
        </PaneLayout>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted" role="status">
          Loading Notepad…
        </div>
      )}
    </section>
  );
}
