import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiMailSendLine,
  RiCloseLine,
  RiUser3Line,
  RiTimeLine,
  RiMailCheckLine,
  RiArrowLeftLine,
  RiAttachment2,
  RiErrorWarningLine,
  RiRefreshLine,
  RiInboxLine,
  RiChat3Line
} from 'react-icons/ri'

interface Attachment {
  filename: string
  mimeType: string
  size: number
}

interface ThreadMessage {
  id: string
  from: string
  sender: string
  subject: string
  preview: string
  date: string
  body: string
  attachments: Attachment[]
  isMe?: boolean
  labels?: string[]
}

interface ParsedEmail {
  id: string
  threadId?: string
  latestMessageId?: string
  from: string
  sender?: string
  participants?: string[]
  subject: string
  preview: string
  date: string
  body: string
  attachments: Attachment[]
  threadMessages?: ThreadMessage[]
  messageCount?: number
  unread?: boolean
  labels?: string[]
}

const cleanSender = (from: string) => from.replace(/<.*>/, '').replace(/^"|"$/g, '').trim()

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

const formatTime = (dateValue: string) => {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const formatDateTime = (dateValue: string) => {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const bodyToSrcDoc = (body: string) => {
  const content = body || ''
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(content)
  if (looksLikeHtml) return content

  return `
    <!doctype html>
    <html>
      <body style="margin:0;background:#ffffff;color:#18181b;font:15px/1.6 Inter,system-ui,sans-serif;">
        <pre style="white-space:pre-wrap;font:inherit;margin:0;">${escapeHtml(content)}</pre>
      </body>
    </html>
  `
}

const normalizeAttachments = (attachments: unknown): Attachment[] =>
  Array.isArray(attachments) ? attachments : []

const normalizeEmail = (email: any): ParsedEmail => ({
  ...email,
  attachments: normalizeAttachments(email?.attachments),
  threadMessages: Array.isArray(email?.threadMessages)
    ? email.threadMessages.map((message: any) => ({
        ...message,
        attachments: normalizeAttachments(message?.attachments)
      }))
    : undefined
})

export default function EmailWidget() {
  const [isVisible, setIsVisible] = useState(false)
  const [emails, setEmails] = useState<ParsedEmail[]>([])
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  useEffect(() => {
    const handleEvent = (event: any) => {
      const detail = event.detail || {}
      const nextEmails = Array.isArray(detail.emails) ? detail.emails.map(normalizeEmail) : []
      const keepSelection = Boolean(detail.refreshed)

      setErrorMessage(typeof detail.error === 'string' && detail.error.trim() ? detail.error : null)
      setEmails(nextEmails)
      setIsVisible(true)
      setSelectedEmail((current) => {
        if (!keepSelection || !current) return null
        return (
          nextEmails.find(
            (email: ParsedEmail) =>
              (email.threadId && email.threadId === current.threadId) || email.id === current.id
          ) || current
        )
      })
    }

    window.addEventListener('show-emails', handleEvent)
    return () => window.removeEventListener('show-emails', handleEvent)
  }, [])

  const refreshInbox = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const result: any = await window.electron.ipcRenderer.invoke('gmail-read', 10)
      window.dispatchEvent(
        new CustomEvent('show-emails', {
          detail: { emails: result.uiData || [], error: result.error || null, refreshed: true }
        })
      )
    } finally {
      setIsRefreshing(false)
    }
  }

  const selectedMessages = useMemo(() => {
    if (!selectedEmail) return []
    if (selectedEmail.threadMessages?.length) return selectedEmail.threadMessages
    return [
      {
        id: selectedEmail.id,
        from: selectedEmail.from,
        sender: selectedEmail.sender || cleanSender(selectedEmail.from),
        subject: selectedEmail.subject,
        preview: selectedEmail.preview,
        date: selectedEmail.date,
        body: selectedEmail.body,
        attachments: selectedEmail.attachments,
        isMe: false
      }
    ]
  }, [selectedEmail])

  const unreadCount = emails.filter((email) => email.unread).length

  if (!isVisible) return null

  return (
    <div className="fixed inset-0 z-9050 flex items-center justify-center bg-black/90 p-8 backdrop-blur-md animate-in fade-in zoom-in duration-300">
      <div className="relative flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-emerald-500/50 bg-zinc-950 shadow-[0_0_100px_rgba(16,185,129,0.16)]">
        <div className="z-10 flex shrink-0 items-center justify-between border-b border-white/10 bg-black/55 px-6 py-5">
          <div className="flex min-w-0 items-center gap-4">
            {selectedEmail ? (
              <button
                onClick={() => setSelectedEmail(null)}
                className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-zinc-400 transition-colors hover:border-emerald-500/35 hover:bg-emerald-500/15 hover:text-emerald-300"
                title="Back to inbox"
              >
                <RiArrowLeftLine size={24} />
              </button>
            ) : (
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 shadow-[0_0_18px_rgba(16,185,129,0.2)]">
                <RiMailSendLine size={24} />
              </div>
            )}

            <div className="min-w-0">
              <h2 className="truncate text-sm font-black tracking-[0.22em] text-zinc-100">
                {selectedEmail ? 'SECURE MESSAGE VIEW' : 'SECURE INBOX LINK'}
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-400">
                  Primary
                </span>
                <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-400">
                  {emails.length} threads
                </span>
                {unreadCount > 0 && (
                  <span className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-emerald-200">
                    {unreadCount} unread
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={refreshInbox}
              disabled={isRefreshing}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-400 transition-colors hover:border-emerald-500/35 hover:text-emerald-300 disabled:opacity-50"
              title="Refresh inbox"
            >
              <RiRefreshLine size={18} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setIsVisible(false)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-red-500/45 bg-red-500/10 text-red-400 transition-colors hover:bg-red-500 hover:text-white"
              title="Close inbox"
            >
              <RiCloseLine size={20} />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {!selectedEmail && (
              <motion.div
                key="inbox"
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                className="absolute inset-0 overflow-y-auto p-6 scrollbar-small"
              >
                {errorMessage ? (
                  <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                    <RiErrorWarningLine size={48} className="text-red-500/50" />
                    <div className="max-w-2xl">
                      <p className="mb-3 font-mono text-xs tracking-widest text-red-300">
                        GMAIL ACCESS ERROR
                      </p>
                      <p className="font-mono text-sm leading-relaxed text-zinc-400">
                        {errorMessage}
                      </p>
                    </div>
                  </div>
                ) : emails.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-600">
                    <RiMailCheckLine size={48} className="opacity-25" />
                    <p className="font-mono text-xs uppercase tracking-widest opacity-70">
                      INBOX IS EMPTY
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {emails.map((email) => {
                      const displaySender =
                        email.participants?.length
                          ? email.participants.join(', ')
                          : email.sender || cleanSender(email.from)

                      return (
                        <button
                          key={email.threadId || email.id}
                          onClick={() => setSelectedEmail(email)}
                          className="group relative overflow-hidden rounded-lg border border-white/10 bg-white/[0.025] p-4 text-left transition-colors hover:border-emerald-500/35 hover:bg-white/[0.045]"
                        >
                          <div className="absolute inset-0 bg-linear-to-r from-transparent via-transparent to-emerald-500/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

                          <div className="relative z-10 flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                                  <RiUser3Line size={15} />
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate font-mono text-xs text-emerald-200">
                                    {displaySender}
                                  </p>
                                  <p className="mt-1 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                                    <RiTimeLine size={12} />
                                    {formatTime(email.date)}
                                  </p>
                                </div>
                              </div>

                              <div className="flex shrink-0 items-center gap-2">
                                {email.unread && (
                                  <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 font-mono text-[9px] uppercase text-emerald-200">
                                    unread
                                  </span>
                                )}
                                {(email.messageCount || 0) > 1 && (
                                  <span className="flex items-center gap-1 rounded border border-sky-500/20 bg-sky-500/10 px-2 py-1 font-mono text-[9px] uppercase text-sky-200">
                                    <RiChat3Line size={11} />
                                    {email.messageCount}
                                  </span>
                                )}
                                {email.attachments.length > 0 && (
                                  <span className="flex items-center gap-1 rounded border border-white/10 bg-black/30 px-2 py-1 font-mono text-[9px] uppercase text-zinc-300">
                                    <RiAttachment2 size={11} />
                                    {email.attachments.length}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div>
                              <h3 className="line-clamp-2 text-base font-black leading-snug text-zinc-100 transition-colors group-hover:text-white">
                                {email.subject}
                              </h3>
                              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-zinc-500">
                                {email.preview}
                              </p>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </motion.div>
            )}

            {selectedEmail && (
              <motion.div
                key="open-email"
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 18 }}
                className="absolute inset-0 flex flex-col bg-zinc-950"
              >
                <div className="shrink-0 border-b border-white/10 bg-black/25 p-6">
                  <div className="mb-4 flex items-start justify-between gap-6">
                    <div className="min-w-0">
                      <h1 className="line-clamp-2 text-2xl font-black text-white">
                        {selectedEmail.subject}
                      </h1>
                      <p className="mt-2 font-mono text-xs uppercase tracking-widest text-zinc-500">
                        {selectedMessages.length} message
                        {selectedMessages.length === 1 ? '' : 's'} in thread
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-xs text-zinc-400">
                      <RiInboxLine size={15} />
                      Primary
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-6 scrollbar-small">
                  <div className="mx-auto flex max-w-4xl flex-col gap-4">
                    {selectedMessages.map((message) => (
                      <div
                        key={message.id}
                        className={`rounded-lg border p-4 ${
                          message.isMe
                            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                            : 'border-white/10 bg-white/[0.035]'
                        }`}
                      >
                        <div className="mb-4 flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-zinc-100">
                              {message.isMe ? 'You' : cleanSender(message.from)}
                            </p>
                            <p className="mt-1 truncate text-xs text-zinc-500">{message.from}</p>
                          </div>
                          <p className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                            {formatDateTime(message.date)}
                          </p>
                        </div>

                        {message.attachments.length > 0 && (
                          <div className="mb-4 flex flex-wrap gap-2 border-b border-white/10 pb-4">
                            {message.attachments.map((file, idx) => (
                              <div
                                key={`${file.filename}-${idx}`}
                                className="flex max-w-64 items-center gap-3 rounded-md border border-white/10 bg-black/30 px-3 py-2"
                              >
                                <div className="grid h-8 w-8 shrink-0 place-items-center rounded bg-emerald-500/15 text-emerald-300">
                                  <RiAttachment2 size={15} />
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-bold text-zinc-200">
                                    {file.filename}
                                  </p>
                                  <p className="font-mono text-[10px] uppercase text-zinc-500">
                                    {formatBytes(file.size)}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="overflow-hidden rounded-md border border-white/10 bg-white">
                          <iframe
                            title={`email-body-${message.id}`}
                            srcDoc={bodyToSrcDoc(message.body || message.preview)}
                            className="h-64 w-full border-0 bg-white"
                            sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
