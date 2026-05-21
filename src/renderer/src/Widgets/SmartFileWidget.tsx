import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  RiCloseLine,
  RiFileSearchLine,
  RiFolderOpenLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiCheckboxCircleLine,
  RiTimeLine,
  RiScales3Line,
  RiErrorWarningLine
} from 'react-icons/ri'
import { openFile, revealFile } from '@renderer/functions/file-manager-api'

interface SmartFileIntent {
  query?: string
  file_types?: string[] | null
  days_ago?: number | null
  root_target?: string | null
  open_first?: boolean
}

interface SmartFileResult {
  path: string
  name: string
  score: number
  modified: string
  size_kb: number
  type: string
  snippet: string
  source: 'filename' | 'content' | 'mixed'
}

const formatSize = (sizeKb: number) => {
  if (!Number.isFinite(sizeKb)) return '--'
  if (sizeKb > 1024) return `${(sizeKb / 1024).toFixed(1)} MB`
  return `${sizeKb.toFixed(sizeKb > 99 ? 0 : 1)} KB`
}

const sourceLabel: Record<SmartFileResult['source'], string> = {
  filename: 'filename',
  content: 'content',
  mixed: 'mixed'
}

const truncateAtWord = (value: string, maxLength = 165) => {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  const clipped = compact.slice(0, maxLength)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${clipped.slice(0, lastSpace > 100 ? lastSpace : maxLength).trim()}...`
}

const getTypeBadgeClass = (type: string) => {
  const normalized = type.toLowerCase()
  if (['pdf'].includes(normalized)) return 'border-red-500/25 bg-red-500/10 text-red-200'
  if (['doc', 'docx', 'txt', 'md'].includes(normalized)) {
    return 'border-sky-500/25 bg-sky-500/10 text-sky-200'
  }
  if (['xlsx', 'xls', 'csv'].includes(normalized)) {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  }
  if (['ppt', 'pptx'].includes(normalized)) return 'border-orange-500/25 bg-orange-500/10 text-orange-200'
  if (['py', 'js', 'ts', 'tsx', 'jsx', 'ipynb'].includes(normalized)) {
    return 'border-violet-500/25 bg-violet-500/10 text-violet-200'
  }
  if (['png', 'jpg', 'jpeg', 'webp'].includes(normalized)) {
    return 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-200'
  }
  return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-300'
}

export default function SmartFileWidget() {
  const [isVisible, setIsVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [intent, setIntent] = useState<SmartFileIntent | null>(null)
  const [results, setResults] = useState<SmartFileResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  useEffect(() => {
    const handleResults = (event: any) => {
      const detail = event.detail || {}
      setQuery(detail.intent?.query || detail.query || '')
      setIntent(detail.intent || null)
      setResults(Array.isArray(detail.results) ? detail.results : [])
      setError(typeof detail.error === 'string' ? detail.error : null)
      setCopiedPath(null)
      setIsVisible(true)
    }

    window.addEventListener('smart-file-results', handleResults)
    return () => window.removeEventListener('smart-file-results', handleResults)
  }, [])

  const filterSummary = useMemo(() => {
    const parts: { label: string; value: string }[] = []
    parts.push({ label: 'query', value: query || 'file query' })
    if (intent?.file_types?.length) {
      parts.push({ label: 'type', value: intent.file_types.map((type) => `.${type}`).join(' ') })
    }
    if (intent?.days_ago) parts.push({ label: 'date', value: `last ${intent.days_ago} days` })
    if (intent?.root_target) parts.push({ label: 'root', value: intent.root_target })
    parts.push({ label: 'matches', value: String(results.length) })
    return parts
  }, [intent, query, results.length])

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      setTimeout(() => setCopiedPath(null), 1600)
    } catch {
      setCopiedPath(null)
    }
  }

  if (!isVisible) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-9040 flex items-center justify-center bg-black/85 p-8 backdrop-blur-md"
      >
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          className="flex h-[82vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-emerald-500/40 bg-zinc-950 shadow-[0_0_70px_rgba(16,185,129,0.12)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-black/45 px-6 py-5">
            <div className="flex min-w-0 items-center gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
                <RiFileSearchLine size={24} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-black tracking-[0.22em] text-zinc-100">
                  SMART FILE SEARCH
                </h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {filterSummary.map((filter) => (
                    <span
                      key={`${filter.label}-${filter.value}`}
                      className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-400"
                    >
                      <span className="text-zinc-600">{filter.label}</span> {filter.value}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => setIsVisible(false)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-red-500/45 bg-red-500/10 text-red-400 transition-colors hover:bg-red-500 hover:text-white"
              title="Close file results"
            >
              <RiCloseLine size={20} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-small">
            {error ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <p className="max-w-xl font-mono text-sm leading-relaxed text-red-300">{error}</p>
              </div>
            ) : results.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
                <RiFileSearchLine size={42} className="opacity-40" />
                <p className="font-mono text-xs uppercase tracking-widest">No matching files</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {results.map((file, index) => (
                  <div
                    key={file.path}
                    className="group rounded-lg border border-white/8 bg-white/[0.025] p-4 transition-colors hover:border-emerald-500/35 hover:bg-white/[0.045]"
                  >
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] font-bold uppercase text-emerald-300">
                            #{index + 1}
                          </span>
                          <span
                            className={`rounded border px-2 py-1 font-mono text-[10px] uppercase ${getTypeBadgeClass(file.type || 'file')}`}
                          >
                            {file.type || 'file'}
                          </span>
                          <span className="rounded border border-white/10 bg-black/30 px-2 py-1 font-mono text-[10px] uppercase text-zinc-400">
                            {sourceLabel[file.source]}
                          </span>
                          {file.score < 45 && (
                            <span className="flex items-center gap-1 rounded border border-yellow-500/25 bg-yellow-500/10 px-2 py-1 font-mono text-[10px] uppercase text-yellow-200">
                              <RiErrorWarningLine size={12} /> weak
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => openFile(file.path)}
                          className="block max-w-full truncate text-left text-sm font-black text-zinc-100 transition-colors hover:text-emerald-300"
                          title={file.name}
                        >
                          {file.name}
                        </button>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => openFile(file.path)}
                          title="Open this file in its default app"
                          aria-label="Open this file in its default app"
                          className="grid h-8 w-8 place-items-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300 transition-colors hover:bg-emerald-500 hover:text-black"
                        >
                          <RiExternalLinkLine size={15} />
                        </button>
                        <button
                          onClick={() => revealFile(file.path)}
                          title="Show this file in its folder"
                          aria-label="Show this file in its folder"
                          className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-black/35 text-zinc-400 transition-colors hover:border-cyan-500/30 hover:text-cyan-200"
                        >
                          <RiFolderOpenLine size={15} />
                        </button>
                        <button
                          onClick={() => copyPath(file.path)}
                          title="Copy the full file path"
                          aria-label="Copy the full file path"
                          className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-black/35 text-zinc-400 transition-colors hover:border-emerald-500/30 hover:text-emerald-200"
                        >
                          {copiedPath === file.path ? (
                            <RiCheckboxCircleLine size={15} />
                          ) : (
                            <RiFileCopyLine size={15} />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      <span className="flex items-center gap-1.5">
                        <RiScales3Line size={12} />
                        {file.score.toFixed(1)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <RiTimeLine size={12} />
                        {file.modified}
                      </span>
                      <span>{formatSize(file.size_kb)}</span>
                    </div>

                    <p className="mb-3 line-clamp-2 min-h-10 text-xs leading-relaxed text-zinc-400">
                      {file.snippet ? truncateAtWord(file.snippet) : 'Matched by filename and metadata.'}
                    </p>

                    <p
                      className="truncate rounded bg-black/35 px-2 py-2 font-mono text-[10px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100"
                      title={file.path}
                    >
                      {file.path}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
