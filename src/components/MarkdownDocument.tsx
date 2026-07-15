import Markdown from "react-markdown";
import "./MarkdownDocument.css";

type MarkdownDocumentProps = {
  source: string;
  className?: string;
};

export function MarkdownDocument({ source, className = "" }: MarkdownDocumentProps) {
  return (
    <article className={`markdown-document ${className}`.trim()}>
      <Markdown>{source}</Markdown>
    </article>
  );
}
