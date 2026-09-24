import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

export function MessageContent({ text }: { text: string }) {
  return <div className="message-content text-body-md leading-relaxed min-w-0">
    <Markdown remarkPlugins={plugins} skipHtml components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
      // Model-supplied media is a link, so rendering a reply does not make an
      // unsolicited request to a remote image host.
      img: ({ src, alt }) => <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener">{alt || 'View image'}</a>,
    }}>{text}</Markdown>
  </div>
}
