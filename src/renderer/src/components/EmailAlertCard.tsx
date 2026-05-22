// Dashboard notification cards for ambient email alerts.
// Listens for 'email:new-alert' IPC events and displays inline cards
// in the transcript panel. Includes a ReplyModal for confirm-before-send.

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiMailLine,
  RiCloseLine,
  RiReplyLine,
  RiSendPlane2Line,
  RiEditLine,
  RiAlertLine
} from 'react-icons/ri'

interface EmailAlert {
  id: string
  threadId: string
  from: string
  sender: string
  subject: string
  snippet: string
  date: string
  score: number
  category: string
  summary: string
  action_items: string[]
  suggested_reply: string | null
  timestamp: string
}

export default function EmailAlertCard() {
  const [alerts, setAlerts] = useState<EmailAlert[]>([])
  const [replyModal, setReplyModal] = useState<{
    alert: EmailAlert
    draft: string
  } | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [sendStatus, setSendStatus] = useState<string | null>(null)

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'email:new-alert',
      (_event: any, payload: any) => {
        if (!payload?.id) return
        setAlerts((current) => {
          const exists = current.some((a) => a.id === payload.id)
          if (exists) return current
          return [payload, ...current].slice(0, 5)
        })
      }
    )

    return () => {
      if (typeof removeListener === 'function') removeListener()
    }
  }, [])

  const dismissAlert = useCallback((id: string) => {
    setAlerts((current) => current.filter((a) => a.id !== id))
  }, [])

  const openReply = useCallback((alert: EmailAlert) => {
    setReplyModal({
      alert,
      draft: alert.suggested_reply || ''
    })
    setSendStatus(null)
  }, [])

  const confirmSend = async () => {
    if (!replyModal || !replyModal.draft.trim()) return
    setIsSending(true)
    setSendStatus(null)

    try {
      // Extract email address from the "from" field
      const emailMatch = replyModal.alert.from.match(/<([^>]+)>/)
      const to = emailMatch ? emailMatch[1] : replyModal.alert.from.trim()

      const result = await window.electron.ipcRenderer.invoke('gmail-send', {
        to,
        subject: `Re: ${replyModal.alert.subject}`,
        body: replyModal.draft
      })

      if (typeof result === 'string' && result.toLowerCase().includes('error')) {
        setSendStatus(result)
      } else {
        dismissAlert(replyModal.alert.id)
        setReplyModal(null)
      }
    } catch (error: any) {
      setSendStatus(error?.message || 'Failed to send reply.')
    } finally {
      setIsSending(false)
    }
  }

  if (alerts.length === 0 && !replyModal) return null

  return (
    <>
      <AnimatePresence>
        {alerts.map((alert) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="mb-3 rounded-xl border border-cyan-500/20 bg-cyan-950/20 backdrop-blur-sm p-3 relative overflow-hidden group"
          >
            {/* Ambient glow */}
            <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent" />

            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="p-1.5 bg-cyan-500/20 rounded-lg border border-cyan-500/30 shrink-0">
                  <RiMailLine className="text-cyan-400" size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-cyan-300 truncate">
                      {alert.sender}
                    </span>
                    <span
                      className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border shrink-0 ${
                        alert.score >= 9
                          ? 'text-red-400 bg-red-500/10 border-red-500/30'
                          : alert.score >= 7
                            ? 'text-orange-400 bg-orange-500/10 border-orange-500/30'
                            : 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30'
                      }`}
                    >
                      {alert.score}/10
                    </span>
                  </div>
                  <p className="text-[10px] font-bold text-zinc-200 truncate mt-0.5">
                    {alert.subject}
                  </p>
                </div>
              </div>

              <button
                onClick={() => dismissAlert(alert.id)}
                className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
              >
                <RiCloseLine size={14} />
              </button>
            </div>

            <p className="text-[9px] text-zinc-500 font-mono mt-2 line-clamp-1 leading-relaxed">
              {alert.summary}
            </p>

            <div className="flex items-center gap-2 mt-2">
              {alert.suggested_reply && (
                <button
                  onClick={() => openReply(alert)}
                  className="flex items-center gap-1 px-2 py-1 text-[8px] font-bold tracking-widest text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded-md hover:bg-cyan-500/20 transition-all"
                >
                  <RiReplyLine size={10} /> REPLY
                </button>
              )}
              <button
                onClick={() => dismissAlert(alert.id)}
                className="flex items-center gap-1 px-2 py-1 text-[8px] font-bold tracking-widest text-zinc-500 bg-white/5 border border-white/5 rounded-md hover:bg-white/10 transition-all"
              >
                DISMISS
              </button>
              <span className="text-[7px] font-mono text-zinc-600 ml-auto">
                {alert.timestamp
                  ? new Date(alert.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })
                  : ''}
              </span>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Reply Modal */}
      <AnimatePresence>
        {replyModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-lg mx-4 bg-zinc-950 border border-cyan-500/30 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.1)] overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/40">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
                    <RiReplyLine className="text-cyan-400" size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white tracking-wide">DRAFT REPLY</h3>
                    <p className="text-[10px] text-zinc-500 font-mono">
                      TO: {replyModal.alert.sender}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setReplyModal(null)}
                  className="p-2 text-zinc-500 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                >
                  <RiCloseLine size={18} />
                </button>
              </div>

              {/* Subject */}
              <div className="px-4 py-3 border-b border-white/5">
                <p className="text-[10px] text-zinc-500 font-mono tracking-widest mb-1">SUBJECT</p>
                <p className="text-sm text-zinc-200 font-medium">
                  Re: {replyModal.alert.subject}
                </p>
              </div>

              {/* Draft Editor */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <RiEditLine className="text-zinc-600" size={12} />
                  <span className="text-[9px] text-zinc-600 font-mono tracking-widest">
                    AI-GENERATED DRAFT — EDIT BEFORE SENDING
                  </span>
                </div>
                <textarea
                  value={replyModal.draft}
                  onChange={(e) =>
                    setReplyModal((prev) => (prev ? { ...prev, draft: e.target.value } : null))
                  }
                  rows={5}
                  className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-zinc-200 resize-none focus:border-cyan-500/30 outline-none transition-all font-mono scrollbar-small"
                  placeholder="Type your reply..."
                />
              </div>

              {/* Error */}
              {sendStatus && (
                <div className="mx-4 mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
                  <RiAlertLine className="text-red-400 shrink-0 mt-0.5" size={14} />
                  <p className="text-[10px] text-red-300 font-mono">{sendStatus}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 px-4 pb-4">
                <button
                  onClick={confirmSend}
                  disabled={isSending || !replyModal.draft.trim()}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-cyan-500/20 hover:bg-cyan-500 text-cyan-400 hover:text-black font-bold text-[11px] tracking-widest rounded-lg border border-cyan-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RiSendPlane2Line size={16} />
                  {isSending ? 'TRANSMITTING...' : 'CONFIRM & SEND'}
                </button>
                <button
                  onClick={() => setReplyModal(null)}
                  disabled={isSending}
                  className="px-6 py-3 bg-white/5 text-zinc-400 hover:text-white font-bold text-[11px] tracking-widest rounded-lg border border-white/10 transition-all"
                >
                  CANCEL
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
