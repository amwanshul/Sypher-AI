// Ambient Email Watcher — polls Gmail every 2 minutes, scores emails via Groq,
// pushes high-importance alerts to renderer, and auto-writes action items to Notes.
// Mirrors the ADB manager's monitorConnection / pushPhoneEvent pattern.

import { BrowserWindow, app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { google } from 'googleapis'
import Groq from 'groq-sdk'
import {
  authorizeGmail,
  findHeader,
  decodeHtmlEntities,
  cleanSenderName,
  parseMessageParts
} from '../logic/gmail-manager'

// ---------- Types ----------

interface EmailAnalysis {
  score: number
  category: 'action_required' | 'meeting' | 'financial' | 'fyi' | 'newsletter'
  summary: string
  action_items: string[]
  suggested_reply: string | null
  should_notify: boolean
}

interface ProcessedEmail {
  id: string
  threadId: string
  from: string
  sender: string
  subject: string
  snippet: string
  date: string
  body: string
  analysis: EmailAnalysis
}

// ---------- State ----------

let watcherInterval: NodeJS.Timeout | null = null
let watcherBusy = false
let lastChecked: string | null = null
let emailsProcessed = 0
const seenIds = new Set<string>()

const POLLING_MS = 120_000 // 2 minutes
const SEEN_IDS_PATH = () => path.join(app.getPath('userData'), 'email-seen-ids.json')
const NOTES_DIR = () => path.resolve(app.getPath('userData'), 'Notes')
const VAULT_PATH = () => path.join(app.getPath('userData'), 'iris_secure_vault.json')

// ---------- Persistence ----------

function loadSeenIds(): void {
  try {
    const filePath = SEEN_IDS_PATH()
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      if (Array.isArray(data)) data.forEach((id: string) => seenIds.add(id))
    }
  } catch {}
}

function persistSeenIds(): void {
  try {
    const ids = Array.from(seenIds).slice(-500) // Keep last 500 to prevent unbounded growth
    fs.writeFileSync(SEEN_IDS_PATH(), JSON.stringify(ids), 'utf-8')
  } catch {}
}

// ---------- Push to Renderer ----------

function pushEmailEvent(channel: string, payload: Record<string, any>): void {
  const event = { timestamp: new Date().toISOString(), ...payload }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, event)
  }
}

// ---------- Groq EmailBrain ----------

function getGroqKey(): string | null {
  try {
    const vaultPath = VAULT_PATH()
    if (!fs.existsSync(vaultPath)) return null
    const data = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
    if (!data.groq) return null

    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(data.groq, 'base64'))
    }
    return Buffer.from(data.groq, 'base64').toString('utf8')
  } catch {
    return null
  }
}

async function analyzeEmail(
  groqKey: string,
  sender: string,
  subject: string,
  bodyPreview: string
): Promise<EmailAnalysis | null> {
  try {
    const groq = new Groq({ apiKey: groqKey })
    const currentDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: [
            'You are an email intelligence engine. Analyze this email and return ONLY valid JSON.',
            'Fields:',
            '- score: integer 1-10 (urgency/importance)',
            '- category: one of "action_required" | "meeting" | "financial" | "fyi" | "newsletter"',
            '- summary: string, max 20 words, plain English',
            '- action_items: array of strings, each under 10 words, only if action required',
            '- suggested_reply: string or null, under 50 words',
            '- should_notify: boolean (true if score >= 7)'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `Email from: ${sender}`,
            `Subject: ${subject}`,
            `Body preview: ${bodyPreview.slice(0, 400)}`,
            `Current date: ${currentDate}`
          ].join('\n')
        }
      ],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0
    })

    const jsonString = chatCompletion.choices[0]?.message?.content || '{}'
    const parsed = JSON.parse(jsonString)

    return {
      score: Math.max(1, Math.min(10, Number(parsed.score) || 1)),
      category: parsed.category || 'fyi',
      summary: String(parsed.summary || 'No summary available.'),
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items.map(String) : [],
      suggested_reply: parsed.suggested_reply ? String(parsed.suggested_reply) : null,
      should_notify: parsed.score >= 7
    }
  } catch {
    return null
  }
}

// ---------- Notes Writer ----------

function writeEmailDigest(emails: ProcessedEmail[]): void {
  if (emails.length === 0) return

  try {
    const notesDir = NOTES_DIR()
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true })

    // Use date-based filename so only one digest per day
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const fileName = `email_digest_${today}.md`
    const filePath = path.join(notesDir, fileName)

    // If a digest already exists for today, append to it
    let existingContent = ''
    if (fs.existsSync(filePath)) {
      existingContent = fs.readFileSync(filePath, 'utf-8')
    }

    const newEntries = emails.map((email) => {
      const categoryIcon: Record<string, string> = {
        action_required: '🔴',
        meeting: '📅',
        financial: '💰',
        fyi: 'ℹ️',
        newsletter: '📰'
      }
      const icon = categoryIcon[email.analysis.category] || '📧'

      const actionItems = email.analysis.action_items.length > 0
        ? '\n**Action Items:**\n' + email.analysis.action_items.map((item) => `- [ ] ${item}`).join('\n')
        : ''

      const replyHint = email.analysis.suggested_reply
        ? `\n> 💬 **Suggested Reply:** ${email.analysis.suggested_reply}`
        : ''

      return [
        `### ${icon} ${email.subject}`,
        `**From:** ${email.sender} · **Score:** ${email.analysis.score}/10 · **Category:** \`${email.analysis.category}\``,
        `**Summary:** ${email.analysis.summary}`,
        actionItems,
        replyHint
      ].filter(Boolean).join('\n')
    }).join('\n\n---\n\n')

    let fullContent: string
    if (existingContent) {
      // Append new entries to existing digest
      fullContent = existingContent + '\n\n---\n\n' + newEntries
    } else {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      fullContent = [
        `# 📬 Email Priority Digest — ${today}`,
        `> Generated at ${timestamp} by SYPHER Email Watcher`,
        '',
        '---',
        '',
        newEntries
      ].join('\n')
    }

    fs.writeFileSync(filePath, fullContent, 'utf-8')

    pushEmailEvent('email:note-created', {
      title: `email_digest_${today}`,
      count: emails.length,
      subjects: emails.map((e) => e.subject)
    })
  } catch {}
}

// ---------- Core Polling Logic ----------

async function pollEmails(): Promise<void> {
  if (watcherBusy) return
  watcherBusy = true

  try {
    const groqKey = getGroqKey()
    if (!groqKey) {
      watcherBusy = false
      return
    }

    const { client: auth } = await authorizeGmail()
    if (!auth) {
      watcherBusy = false
      return
    }

    const gmail = google.gmail({ version: 'v1', auth: auth as any })
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: 'is:unread category:primary'
    })

    const messages = res.data.messages || []
    lastChecked = new Date().toISOString()

    if (messages.length === 0) {
      watcherBusy = false
      return
    }

    const digestQueue: ProcessedEmail[] = []

    for (const msg of messages) {
      if (!msg.id || seenIds.has(msg.id)) continue

      seenIds.add(msg.id)
      emailsProcessed++

      try {
        const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id })
        const headers = fullMsg.data.payload?.headers || []

        const subject = decodeHtmlEntities(findHeader(headers, 'Subject')) || 'No Subject'
        const from = decodeHtmlEntities(findHeader(headers, 'From')) || 'Unknown'
        const sender = cleanSenderName(from)
        const date = findHeader(headers, 'Date')
        const snippet = decodeHtmlEntities(fullMsg.data.snippet || '')
        const parsed = parseMessageParts(fullMsg.data.payload)
        const bodyText = parsed.text || snippet

        const analysis = await analyzeEmail(groqKey, sender, subject, bodyText)
        if (!analysis) continue

        const processedEmail: ProcessedEmail = {
          id: msg.id,
          threadId: fullMsg.data.threadId || '',
          from,
          sender,
          subject,
          snippet,
          date,
          body: parsed.html || parsed.text || snippet,
          analysis
        }

        // Queue for digest note only if score >= 7 (high priority)
        if (analysis.score >= 7) {
          digestQueue.push(processedEmail)
        }

        // Push alert to renderer if score >= 7
        if (analysis.should_notify) {
          pushEmailEvent('email:new-alert', {
            id: processedEmail.id,
            threadId: processedEmail.threadId,
            from: processedEmail.from,
            sender: processedEmail.sender,
            subject: processedEmail.subject,
            snippet: processedEmail.snippet,
            date: processedEmail.date,
            score: analysis.score,
            category: analysis.category,
            summary: analysis.summary,
            action_items: analysis.action_items,
            suggested_reply: analysis.suggested_reply
          })
        }
      } catch {}
    }

    // Write a single consolidated digest note for all high-priority emails
    if (digestQueue.length > 0) {
      writeEmailDigest(digestQueue)
    }

    persistSeenIds()
  } catch {} finally {
    watcherBusy = false
  }
}

// ---------- Public API ----------

export function startEmailWatcher(): void {
  if (watcherInterval) return

  loadSeenIds()

  // Initial poll after 10 seconds (let the app fully boot)
  setTimeout(() => void pollEmails(), 10_000)

  watcherInterval = setInterval(() => {
    void pollEmails()
  }, POLLING_MS)
}

export function stopEmailWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval)
    watcherInterval = null
  }
}

export function getEmailWatcherStatus(): {
  running: boolean
  lastChecked: string | null
  emailsProcessed: number
} {
  return {
    running: watcherInterval !== null,
    lastChecked,
    emailsProcessed
  }
}
