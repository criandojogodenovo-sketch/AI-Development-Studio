'use client'

// ============================================================
// STUDIO / MARKDOWN — renderização de saídas dos agentes
// (títulos, listas, tabelas, código, blockquotes etc.)
// ============================================================

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ content, compact = false }: { content: string; compact?: boolean }) {
  if (!content?.trim()) return null
  return (
    <div className={`markdown-body text-zinc-300 ${compact ? 'text-xs' : 'text-sm'} leading-relaxed break-words`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-base font-bold text-zinc-100 mt-3 mb-1.5 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-bold text-zinc-100 mt-3 mb-1.5 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13px] font-semibold text-zinc-200 mt-2.5 mb-1 first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="marker:text-emerald-500/70">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-400">{children}</em>,
          hr: () => <hr className="border-zinc-800 my-2.5" />,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline underline-offset-2 break-all">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-emerald-700/60 pl-3 my-2 text-zinc-400 italic">{children}</blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return (
                <code className="block font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre text-emerald-300/90">
                  {children}
                </code>
              )
            }
            return <code className="font-mono text-[11px] bg-zinc-800/80 text-emerald-300 px-1 py-0.5 rounded">{children}</code>
          },
          pre: ({ children }) => (
            <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-2.5 my-2 overflow-x-auto">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 border border-zinc-800 rounded-md">
              <table className="w-full text-left text-[11px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-zinc-900/80 text-zinc-200">{children}</thead>,
          th: ({ children }) => <th className="border-b border-zinc-800 px-2 py-1.5 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-zinc-800/60 px-2 py-1.5 align-top">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
