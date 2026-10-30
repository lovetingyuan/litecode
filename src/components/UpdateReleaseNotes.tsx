import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function UpdateReleaseNotes({
  notes,
  openLink,
}: {
  notes: string | null;
  openLink: (url: string) => void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) =>
          href && /^https?:\/\//i.test(href) ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                openLink(href);
              }}
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: ({ alt }) => <span>{alt}</span>,
      }}
    >
      {notes || "No release notes provided."}
    </Markdown>
  );
}
