import fs from 'fs'
import path from 'path'
import { IpcMain, App } from 'electron'

const NON_ENGLISH_SCRIPT_PATTERN =
  /[\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0b00-\u0b7f\u0b80-\u0bff\u0c00-\u0c7f\u0d00-\u0d7f]/

const ROMANIZED_MIXED_LANGUAGE_PATTERN =
  /\b(aap|apko|bata|bataya|hai|haan|kar|karo|kya|lagta|maine|mujhe|nahi|nahin|pehle|raha|sakoon|taaki|woh|yaar)\b/i

const MOJIBAKE_PATTERN = /(?:Ã|Â|â|ð|à[°-¿]|à¤|à¥|à°|à±)/i

const MISLEADING_GMAIL_PERMISSION_PATTERN =
  /(waiting for your confirmation|shall i proceed to enable the gmail api|permission.*enable.*gmail api|same error.*api|time to propagate)/i

const SYSTEM_NOTICE_PATTERN = /^\[System Notice[^\]]*\]/i
const INTERNAL_CONTEXT_UPDATE_PATTERN = /\bcontext update only\b/i

const MODEL_FILLER_PATTERN =
  /^(okay|ok|noted|understood|got it|sure|acknowledged|acknolodged|acknowledged here|acknolodged here|how can i assist you|system notice acknowledged)[.!?]*$/i

const LEGACY_EMAIL_SUMMARY_PATTERN = /^you have\s+\d+\s+(?:new|recent)\s+emails?:/i

const getMessageContent = (msg: any) =>
  String(msg?.parts?.[0]?.text || msg?.content || '').trim()

const shouldHideTranscript = (content: string, role?: string) =>
  !content ||
  NON_ENGLISH_SCRIPT_PATTERN.test(content) ||
  ROMANIZED_MIXED_LANGUAGE_PATTERN.test(content) ||
  MOJIBAKE_PATTERN.test(content) ||
  MISLEADING_GMAIL_PERMISSION_PATTERN.test(content) ||
  SYSTEM_NOTICE_PATTERN.test(content) ||
  INTERNAL_CONTEXT_UPDATE_PATTERN.test(content) ||
  (role === 'model' && LEGACY_EMAIL_SUMMARY_PATTERN.test(content)) ||
  (role === 'model' && MODEL_FILLER_PATTERN.test(content))

export default function registerIpcHandlers({ ipcMain, app }: { ipcMain: IpcMain; app: App }) {
  const CHAT_DIR = path.resolve(app.getPath('userData'), 'Chat')
  const FILE_PATH = path.join(CHAT_DIR, 'iris_memory.json')

  ipcMain.removeHandler('add-message')
  ipcMain.removeHandler('get-history')
  ipcMain.removeHandler('clear-history')

  ipcMain.handle('add-message', async (_event, msg) => {
    try {
      if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true })
      const role = msg.role === 'iris' ? 'model' : msg.role
      const content = getMessageContent(msg)
      if (shouldHideTranscript(content, role)) return true

      let history: { role: string; content: string; timestamp: string }[] = []
      if (fs.existsSync(FILE_PATH)) {
        const data = fs.readFileSync(FILE_PATH, 'utf-8')
        history = data ? JSON.parse(data) : []
      }

      const newEntry: { role: string; content: string; timestamp: string } = {
        role,
        content,
        timestamp: new Date().toISOString()
      }
      history.push(newEntry)

      if (history.length > 20) history = history.slice(-20)

      fs.writeFileSync(FILE_PATH, JSON.stringify(history, null, 2))
      return true
    } catch (err) {
      return false
    }
  })

  ipcMain.handle('get-history', async () => {
    try {
      if (fs.existsSync(FILE_PATH)) {
        const data = fs.readFileSync(FILE_PATH, 'utf-8')
        const raw = JSON.parse(data)
        return raw
          .map((m: any) => ({
            role: m.role === 'iris' ? 'model' : m.role,
            content: getMessageContent(m)
          }))
          .filter((m: any) => !shouldHideTranscript(m.content, m.role))
          .map((m: any) => ({
            role: m.role,
            parts: [{ text: m.content }]
          }))
      }
    } catch (err) {}
    return []
  })

  ipcMain.handle('clear-history', async () => {
    try {
      if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true })
      fs.writeFileSync(FILE_PATH, JSON.stringify([], null, 2))
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })
}
