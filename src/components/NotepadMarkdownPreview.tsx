import markdownPreviewStyles from "../components/MarkdownPreview.module.css";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage } from "../core/bridge";
import { previewFontStyle } from "../editor/font";
import { notify, useApp } from "../store/store";

export function NotepadMarkdownPreview({
  title,
  text,
  syntaxHighlight = true,
}: Readonly<{ title: string; text: string; syntaxHighlight?: boolean }>) {
  const settings = useApp((s) => s.settings);
  const components: Components = {
    a: ({ href, children, title: linkTitle }) =>
      href && /^https?:\/\//i.test(href) ? (
        <a
          href={href}
          title={linkTitle}
          onClick={(event) => {
            event.preventDefault();
            void openUrl(href).catch((error) => notify(errorMessage(error)));
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    table: ({ children }) => (
      <div className="markdown-table">
        <table>{children}</table>
      </div>
    ),
  };

  return (
    <div
      className={`markdown-preview flex-1 min-w-0 min-h-0 overflow-auto bg-editor text-foreground ${markdownPreviewStyles["markdown-preview"]}`}
      style={previewFontStyle(settings)}
      tabIndex={0}
      aria-label={`Markdown preview: ${title}`}
      onCopy={(event) => {
        if (syntaxHighlight) {
          return;
        }
        const selected = window.getSelection()?.toString();
        if (selected) {
          event.preventDefault();
          event.clipboardData.setData("text/plain", selected);
        }
      }}
    >
      <article
        className={`markdown-body max-w-245 my-0 mx-auto text-[14px] leading-[1.65] select-text ${markdownPreviewStyles["markdown-body"]}`}
      >
        {text.trim() ? (
          <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
            {text}
          </Markdown>
        ) : (
          <p className="text-muted">Empty Markdown note.</p>
        )}
      </article>
    </div>
  );
}
