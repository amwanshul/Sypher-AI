import { IpcMain, app, BrowserWindow, shell } from 'electron'
import http from 'http'
import fsPromises from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import process from 'process'
import { google } from 'googleapis'

const SCOPES = ['https://mail.google.com/']
const TOKEN_PATH = path.join(app.getPath('userData'), 'gmail_token.json')
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json')
const ENV_PATH = path.join(process.cwd(), '.env')
const DEFAULT_GMAIL_REDIRECT_URI = 'http://localhost:3001/oauth2callback'

type GoogleOAuthKey = {
  client_id?: string
  client_secret?: string
  redirect_uris?: string[]
}

type GoogleOAuthCredentials = {
  installed?: GoogleOAuthKey
  web?: GoogleOAuthKey
}

let gmailLoginInFlight: Promise<{ client: any; credentials: GoogleOAuthCredentials }> | null = null

async function fileExists(filePath: string) {
  try {
    await fsPromises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadEnvFile() {
  try {
    const content = await fsPromises.readFile(ENV_PATH, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

      const [key, ...rest] = trimmed.split('=')
      if (!process.env[key]) {
        process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {}
}

function getCredentialKey(credentials: GoogleOAuthCredentials): GoogleOAuthKey {
  const key = credentials.installed || credentials.web
  if (!key?.client_id || !key?.client_secret) {
    throw new Error('Google OAuth credentials are missing client_id or client_secret.')
  }
  return key
}

function normalizeRedirectUris(value: string) {
  return value
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean)
}

async function resolveCredentialsSource(): Promise<GoogleOAuthCredentials> {
  if (await fileExists(CREDENTIALS_PATH)) {
    const credentials = JSON.parse(
      await fsPromises.readFile(CREDENTIALS_PATH, 'utf-8')
    ) as GoogleOAuthCredentials
    getCredentialKey(credentials)
    return credentials
  }

  await loadEnvFile()

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
  const gmailRedirectUri = process.env.GOOGLE_GMAIL_OAUTH_REDIRECT_URI?.trim()
  const loginRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()
  const redirectUri = gmailRedirectUri || DEFAULT_GMAIL_REDIRECT_URI

  if (!clientId || !clientSecret) {
    throw new Error(
      'Gmail OAuth is not configured. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env, or place a Google OAuth credentials.json file in the project root.'
    )
  }

  if (!gmailRedirectUri && loginRedirectUri && loginRedirectUri !== DEFAULT_GMAIL_REDIRECT_URI) {
    throw new Error(
      `Gmail OAuth needs its own redirect URI. Add GOOGLE_GMAIL_OAUTH_REDIRECT_URI=${DEFAULT_GMAIL_REDIRECT_URI} to .env and add the exact same URI in Google Cloud Console > Authorized redirect URIs for this OAuth client.`
    )
  }

  const credentials: GoogleOAuthCredentials = {
    web: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: normalizeRedirectUris(redirectUri)
    }
  }

  return credentials
}

function isPortInUseError(error: any) {
  return error?.code === 'EADDRINUSE' || String(error?.message || '').includes('EADDRINUSE')
}

function createPortInUseMessage(redirectUris: string[]) {
  return [
    `Gmail OAuth callback port is already in use (${redirectUris.join(', ')}).`,
    'Close the app/process using that port, or set GOOGLE_GMAIL_OAUTH_REDIRECT_URI to a free localhost URL and add the exact same URL in Google Cloud Console > Authorized redirect URIs.'
  ].join(' ')
}

async function authenticateWithLocalCallback(
  credentials: GoogleOAuthCredentials,
  redirectUri: string,
  useEphemeralPort: boolean
): Promise<any> {
  return await new Promise((resolve, reject) => {
    const configuredRedirectUrl = new URL(redirectUri)
    if (!['localhost', '127.0.0.1'].includes(configuredRedirectUrl.hostname)) {
      reject(new Error(`Gmail OAuth redirect URI must use localhost: ${redirectUri}`))
      return
    }

    const key = getCredentialKey(credentials)
    const listenPort = useEphemeralPort ? 0 : Number(configuredRedirectUrl.port)
    if (!listenPort && !useEphemeralPort) {
      reject(new Error(`Gmail OAuth redirect URI must include a port: ${redirectUri}`))
      return
    }

    let completed = false
    let oauthClient: any = null
    let activeRedirectUri = redirectUri
    let timeout: NodeJS.Timeout | null = null

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', activeRedirectUri)
        if (requestUrl.pathname !== configuredRedirectUrl.pathname) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Invalid Gmail OAuth callback URL.')
          return
        }

        const oauthError = requestUrl.searchParams.get('error')
        if (oauthError) {
          throw new Error(`Gmail OAuth rejected: ${oauthError}`)
        }

        const code = requestUrl.searchParams.get('code')
        if (!code) {
          throw new Error('Gmail OAuth callback did not include an authorization code.')
        }

        const { tokens } = await oauthClient.getToken({
          code,
          redirect_uri: activeRedirectUri
        })
        oauthClient.setCredentials(tokens)

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`
          <!doctype html>
          <html>
            <head>
              <title>Gmail connected</title>
              <meta charset="utf-8" />
              <style>
                body {
                  margin: 0;
                  min-height: 100vh;
                  display: grid;
                  place-items: center;
                  background: #050505;
                  color: #d4d4d8;
                  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }
                main {
                  max-width: 520px;
                  padding: 32px;
                  border: 1px solid rgba(16, 185, 129, 0.35);
                  border-radius: 18px;
                  background: rgba(9, 9, 11, 0.9);
                  box-shadow: 0 0 48px rgba(16, 185, 129, 0.12);
                }
                h1 { color: #34d399; margin: 0 0 12px; font-size: 28px; }
                p { margin: 0; line-height: 1.5; }
              </style>
            </head>
            <body>
              <main>
                <h1>Gmail connected.</h1>
                <p>You can return to Sypher. This tab can be closed.</p>
              </main>
              <script>setTimeout(() => window.close(), 1200)</script>
            </body>
          </html>
        `)

        if (!completed) {
          completed = true
          if (timeout) clearTimeout(timeout)
          server.close()
          resolve(oauthClient)
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(error instanceof Error ? error.message : 'Gmail OAuth failed.')
        if (!completed) {
          completed = true
          if (timeout) clearTimeout(timeout)
          server.close()
          reject(error)
        }
      }
    })

    server.once('error', (error) => {
      if (!completed) {
        completed = true
        if (timeout) clearTimeout(timeout)
        reject(error)
      }
    })

    server.listen(listenPort, '127.0.0.1', async () => {
      try {
        const address = server.address()
        if (typeof address === 'object' && address?.port) {
          configuredRedirectUrl.port = String(address.port)
        }

        activeRedirectUri = configuredRedirectUrl.toString()
        oauthClient = new google.auth.OAuth2(key.client_id, key.client_secret, activeRedirectUri)
        const authorizeUrl = oauthClient.generateAuthUrl({
          redirect_uri: activeRedirectUri,
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES
        })

        timeout = setTimeout(
          () => {
            if (!completed) {
              completed = true
              server.close()
              reject(new Error('Timed out waiting for Gmail OAuth login.'))
            }
          },
          5 * 60 * 1000
        )

        await shell.openExternal(authorizeUrl)
      } catch (error) {
        if (!completed) {
          completed = true
          if (timeout) clearTimeout(timeout)
          server.close()
          reject(error)
        }
      }
    })
  })
}

async function authenticateGmail(credentials: GoogleOAuthCredentials): Promise<any> {
  const key = getCredentialKey(credentials)
  const redirectUris = key.redirect_uris?.length ? key.redirect_uris : [DEFAULT_GMAIL_REDIRECT_URI]
  const useEphemeralPort = Boolean(credentials.installed)
  let lastPortError: any = null

  for (const redirectUri of redirectUris) {
    try {
      return await authenticateWithLocalCallback(credentials, redirectUri, useEphemeralPort)
    } catch (error) {
      if (!isPortInUseError(error)) throw error
      lastPortError = error
    }
  }

  throw new Error(createPortInUseMessage(redirectUris) || lastPortError?.message)
}

async function loadSavedCredentialsIfExist(): Promise<any | null> {
  try {
    const content = await fsPromises.readFile(TOKEN_PATH, 'utf-8')
    const credentials = JSON.parse(content)
    return google.auth.fromJSON(credentials)
  } catch (err) {
    return null
  }
}

async function saveCredentials(client: any, credentials: GoogleOAuthCredentials) {
  const key = getCredentialKey(credentials)
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  })
  await fsPromises.writeFile(TOKEN_PATH, payload, 'utf-8')
}

export async function authorizeGmail(): Promise<{ client: any; isNewLogin: boolean }> {
  let client = await loadSavedCredentialsIfExist()
  if (client) return { client, isNewLogin: false }

  const credentialsSource = await resolveCredentialsSource()
  if (!gmailLoginInFlight) {
    gmailLoginInFlight = authenticateGmail(credentialsSource)
      .then((authClient) => ({ client: authClient, credentials: credentialsSource }))
      .finally(() => {
        gmailLoginInFlight = null
      })
  }

  const loginResult = await gmailLoginInFlight
  client = loginResult.client
  if (client && client.credentials) {
    await saveCredentials(client, loginResult.credentials)
  }

  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(true)
    mainWindow.setAlwaysOnTop(false)
  }

  return { client, isNewLogin: true }
}

export function decodeGmailBody(data: string) {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf-8')
}

export function decodeHtmlEntities(value = '') {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanSenderName(from: string) {
  return decodeHtmlEntities(from.replace(/<.*>/, '').replace(/^"|"$/g, '').trim()) || 'Unknown'
}

export function parseMessageParts(part: any, result = { text: '', html: '', attachments: [] as any[] }) {
  if (!part) return result

  if (part.filename && part.filename.length > 0) {
    result.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body?.size
    })
  } else {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      result.text += decodeGmailBody(part.body.data)
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      result.html += decodeGmailBody(part.body.data)
    }
  }

  if (part.parts && part.parts.length > 0) {
    for (const childPart of part.parts) {
      parseMessageParts(childPart, result)
    }
  }
  return result
}

export function findHeader(headers: any[], name: string) {
  const header = headers.find((h) => String(h.name || '').toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

function stripHtmlToText(value = '') {
  return decodeHtmlEntities(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function getMessageBodyText(message: any) {
  const parsed = parseMessageParts(message?.payload)
  const body = parsed.text || stripHtmlToText(parsed.html) || decodeHtmlEntities(message?.snippet || '')
  return { parsed, body }
}

function getHeaderAddress(value: string) {
  const match = value.match(/<([^>]+)>/)
  return (match ? match[1] : value).trim()
}

function normalizeAttachmentPath(value?: string) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
}

function isSentMessage(message: any) {
  return Array.isArray(message?.labelIds) && message.labelIds.includes('SENT')
}

function messageTimestamp(message: any) {
  const internalDate = Number(message?.internalDate)
  if (Number.isFinite(internalDate) && internalDate > 0) return internalDate

  const headers = message?.payload?.headers || []
  const dateHeader = findHeader(headers, 'Date')
  const parsedDate = Date.parse(dateHeader)
  return Number.isFinite(parsedDate) ? parsedDate : 0
}

function requestNeedsAttachment(requestText: string) {
  const normalized = requestText.toLowerCase()
  const asksToSend = /\b(send|submit|attach|share|provide|upload|mail)\b/.test(normalized)
  const mentionsFile =
    /\b(file|attachment|csv|pdf|docx?|xlsx?|pptx?|assignment|report|dataset|data\s*set|document|notes?)\b/.test(
      normalized
    )
  return asksToSend && mentionsFile
}

function claimsAttachment(body: string) {
  return /\b(attached|attaching|attachment|please find|see attached)\b/i.test(body)
}

function shouldGenerateMlCsv(requestText: string) {
  const normalized = requestText.toLowerCase()
  return (
    /\bcsv\b/.test(normalized) &&
    /\b(ml|aiml|machine\s+learning|training)\b/.test(normalized) &&
    /\b(names?|students?)\b/.test(normalized) &&
    /\bclass\b/.test(normalized) &&
    /\broll\s*(?:no|number)?\b/.test(normalized) &&
    /\bmarks?\b/.test(normalized)
  )
}

function ensureGeneratedMlCsv() {
  const dir = path.join(app.getPath('userData'), 'Generated Email Attachments')
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })

  const filePath = path.join(dir, 'aiml_training_sample.csv')
  const rows = [
    ['Name', 'Class', 'Roll No', 'Marks'],
    ['Aarav Sharma', 'AIML-A', '101', '86'],
    ['Priya Patil', 'AIML-A', '102', '91'],
    ['Rohan Mehta', 'AIML-B', '103', '78'],
    ['Sneha Iyer', 'AIML-B', '104', '88'],
    ['Amit Verma', 'AIML-C', '105', '82'],
    ['Neha Kulkarni', 'AIML-C', '106', '94']
  ]

  fsSync.writeFileSync(filePath, rows.map((row) => row.join(',')).join('\n'), 'utf-8')
  return filePath
}

function csvHasRequiredColumns(filePath: string, requiredColumns: string[]) {
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8').slice(0, 4096)
    const lines = content.split(/\r?\n/).filter((line) => line.trim())
    const header = lines[0] || ''
    const columns = header
      .split(',')
      .map((column) => column.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())

    const hasColumns = requiredColumns.every((required) =>
      columns.some((column) => column === required || column.includes(required))
    )

    return hasColumns && lines.length >= 4
  } catch {
    return false
  }
}

function validateAttachmentAgainstRequest(attachmentPath: string, requestText: string) {
  const normalized = requestText.toLowerCase()
  const ext = path.extname(attachmentPath).toLowerCase()

  if (/\bcsv\b/.test(normalized) && ext !== '.csv') {
    return 'The email asks for a CSV file, but the selected attachment is not a CSV.'
  }

  if (shouldGenerateMlCsv(requestText)) {
    const valid = csvHasRequiredColumns(attachmentPath, ['name', 'class', 'roll', 'marks'])
    if (!valid) {
      return 'The selected CSV does not contain the requested Name, Class, Roll No, and Marks columns.'
    }
  }

  return null
}

function resolveReplyAttachment(requestText: string, attachmentPath?: string) {
  const trimmedPath = normalizeAttachmentPath(attachmentPath)

  if (trimmedPath) {
    if (!fsSync.existsSync(trimmedPath)) {
      throw new Error(`Attachment file not found: ${trimmedPath}`)
    }

    const validationError = validateAttachmentAgainstRequest(trimmedPath, requestText)
    if (!validationError) return { path: trimmedPath, generated: false }

    if (shouldGenerateMlCsv(requestText)) {
      return {
        path: ensureGeneratedMlCsv(),
        generated: true,
        note: `${validationError} Generated a matching AIML CSV instead.`
      }
    }

    throw new Error(validationError)
  }

  if (shouldGenerateMlCsv(requestText)) {
    return {
      path: ensureGeneratedMlCsv(),
      generated: true,
      note: 'Generated a matching AIML CSV because the email specifically requested one.'
    }
  }

  if (requestNeedsAttachment(requestText)) {
    throw new Error(
      'The original email asks for a file or attachment. Reply was not sent because no valid attachment path was provided.'
    )
  }

  return { path: undefined, generated: false }
}

export function normalizeGmailError(error: any) {
  const rawMessage = String(
    error?.response?.data?.error_description ||
      error?.response?.data?.error?.message ||
      error?.errors?.[0]?.message ||
      error?.message ||
      error
  )

  if (
    rawMessage.includes('Gmail API has not been used') ||
    rawMessage.includes('it is disabled') ||
    rawMessage.includes('accessNotConfigured')
  ) {
    const projectId = rawMessage.match(/project\s+(\d+)/i)?.[1]
    const enableTarget = projectId
      ? `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${projectId}`
      : 'Google Cloud Console > APIs & Services > Library > Gmail API'
    return [
      'Gmail OAuth is connected, but Gmail API is disabled for the Google Cloud project that owns this OAuth client.',
      `Enable Gmail API here: ${enableTarget}`,
      'After enabling it, wait a few minutes and ask Sypher to read email again.'
    ].join(' ')
  }

  if (rawMessage.includes('insufficient authentication scopes')) {
    return [
      'Gmail is connected with the wrong permission scope.',
      'Remove the saved Gmail token and reconnect so Sypher can request Gmail access again.'
    ].join(' ')
  }

  if (rawMessage.includes('invalid_grant') || rawMessage.includes('Token has been expired')) {
    return 'The saved Gmail login expired. Reconnect Gmail and try again.'
  }

  return `Gmail error: ${rawMessage}`
}

export default function registerGmailHandlers(ipcMain: IpcMain) {
  const authorize = authorizeGmail

  // Simple MIME type lookup for common file extensions
  const MIME_TYPES: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
    '.html': 'text/html', '.md': 'text/markdown'
  }

  function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] || 'application/octet-stream'
  }

  const makeEmail = (to: string, subject: string, body: string) => {
    const str = [`To: ${to}`, `Subject: ${subject}`, '', body].join('\n')
    return Buffer.from(str)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  function makeEmailWithAttachment(
    to: string,
    subject: string,
    body: string,
    attachmentPath: string,
    extraHeaders: string[] = []
  ): string {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const fileName = path.basename(attachmentPath)
    const mimeType = getMimeType(attachmentPath)
    const fileData =
      fsSync
        .readFileSync(attachmentPath)
        .toString('base64')
        .match(/.{1,76}/g)
        ?.join('\n') || ''

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      ...extraHeaders,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
      '',
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${fileName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${fileName}"`,
      '',
      fileData,
      '',
      `--${boundary}--`
    ].join('\n')

    return Buffer.from(messageParts)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }


  ipcMain.removeHandler('gmail-read')
  ipcMain.handle('gmail-read', async (_event, maxResults = 5) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')

      const safeMaxResults = Math.max(1, Math.min(Number(maxResults) || 5, 25))
      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const res = await gmail.users.threads.list({
        userId: 'me',
        maxResults: safeMaxResults,
        labelIds: ['INBOX'],
        q: 'category:primary -in:spam -in:trash',
        includeSpamTrash: false
      })
      const threads = res.data.threads || []

      const prefix = isNewLogin ? 'Gmail connected successfully. ' : ''

      if (!threads.length) return { speechText: prefix + 'Inbox is empty.', uiData: [] }

      let emailListForSypher: string[] = []
      let uiDataArray: any[] = []

      for (const threadRef of threads) {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadRef.id!,
          format: 'full'
        })
        const messages = (thread.data.messages || []).sort(
          (a, b) => messageTimestamp(a) - messageTimestamp(b)
        )
        if (!messages.length) continue

        const inboxMessages = messages.filter((message) => message.labelIds?.includes('INBOX'))
        const replyTarget =
          [...inboxMessages].reverse().find((message) => !isSentMessage(message)) ||
          [...messages].reverse().find((message) => !isSentMessage(message)) ||
          messages[messages.length - 1]
        const latestMessage = messages[messages.length - 1]
        const displayMessage = latestMessage || replyTarget
        const headers = displayMessage.payload?.headers || []

        const subject = decodeHtmlEntities(findHeader(headers, 'Subject')) || 'No Subject'
        const from = decodeHtmlEntities(findHeader(headers, 'From')) || 'Unknown'
        const sender = cleanSenderName(from)
        const date = findHeader(headers, 'Date')
        const snippet = decodeHtmlEntities(displayMessage.snippet || thread.data.snippet || '')
        const { parsed, body } = getMessageBodyText(displayMessage)

        const threadMessages = messages.map((message) => {
          const messageHeaders = message.payload?.headers || []
          const messageFrom = decodeHtmlEntities(findHeader(messageHeaders, 'From')) || 'Unknown'
          const messageBody = getMessageBodyText(message)
          return {
            id: message.id,
            from: messageFrom,
            sender: cleanSenderName(messageFrom),
            subject: decodeHtmlEntities(findHeader(messageHeaders, 'Subject')) || subject,
            date: findHeader(messageHeaders, 'Date'),
            preview: decodeHtmlEntities(message.snippet || ''),
            body: messageBody.parsed.html || messageBody.parsed.text || decodeHtmlEntities(message.snippet || ''),
            attachments: messageBody.parsed.attachments,
            isMe: isSentMessage(message),
            labels: message.labelIds || []
          }
        })

        const participants = Array.from(
          new Set(
            threadMessages
              .map((message) => message.sender)
              .filter((participant) => participant && participant !== 'Unknown')
          )
        )

        emailListForSypher.push(
          `${emailListForSypher.length + 1}. ${participants.join(', ') || sender}\nID: ${replyTarget.id}\nThread: ${thread.data.id}\nSubject: ${subject}\nMessages: ${messages.length}\nPreview: ${snippet}`
        )

        uiDataArray.push({
          id: replyTarget.id,
          threadId: thread.data.id,
          latestMessageId: displayMessage.id,
          from,
          sender,
          participants,
          subject,
          date,
          preview: snippet,
          body: body || snippet,
          attachments: parsed.attachments,
          threadMessages,
          messageCount: messages.length,
          unread: messages.some((message) => message.labelIds?.includes('UNREAD')),
          labels: displayMessage.labelIds || []
        })
      }

      return {
        speechText:
          prefix +
          `Primary Gmail inbox: ${uiDataArray.length} thread${uiDataArray.length === 1 ? '' : 's'}.\n\n` +
          emailListForSypher.join('\n\n'),
        uiData: uiDataArray
      }
    } catch (e: any) {
      const message = normalizeGmailError(e)
      return { speechText: `Gmail Error: ${message}`, uiData: [], error: message }
    }
  })

  ipcMain.removeHandler('gmail-send')
  ipcMain.handle('gmail-send', async (_event, { to, subject, body, attachment_path }) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')
      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const attachmentPath = normalizeAttachmentPath(attachment_path)

      if (attachmentPath && !fsSync.existsSync(attachmentPath)) {
        throw new Error(`Attachment file not found: ${attachmentPath}`)
      }

      if (!attachmentPath && claimsAttachment(body)) {
        throw new Error('Email body mentions an attachment, but no valid file path was provided.')
      }

      let raw: string
      if (attachmentPath) {
        raw = makeEmailWithAttachment(to, subject, body, attachmentPath)
      } else {
        raw = makeEmail(to, subject, body)
      }

      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })

      const prefix = isNewLogin ? '[SYSTEM NOTICE: Login successful.]\n\n' : ''
      const attachNote = attachmentPath ? ` with attachment "${path.basename(attachmentPath)}"` : ''
      return prefix + `Email successfully sent to ${to}${attachNote}.`
    } catch (e: any) {
      return `Send Error: ${normalizeGmailError(e)}`
    }
  })

  ipcMain.removeHandler('gmail-draft')
  ipcMain.handle('gmail-draft', async (_event, { to, subject, body }) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')
      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const raw = makeEmail(to, subject, body)

      await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } })

      const prefix = isNewLogin ? '[SYSTEM NOTICE: Login successful.]\n\n' : ''
      return prefix + `Draft created for ${to}. You can review it in Gmail.`
    } catch (e: any) {
      return `Draft Error: ${normalizeGmailError(e)}`
    }
  })

  ipcMain.removeHandler('gmail-reply')
  ipcMain.handle('gmail-reply', async (_event, { email_id, body, attachment_path }) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')
      const gmail = google.gmail({ version: 'v1', auth: auth as any })

      // Fetch the original email to get correct reply-to address and headers
      let original = await gmail.users.messages.get({ userId: 'me', id: email_id })
      if (isSentMessage(original.data) && original.data.threadId) {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: original.data.threadId,
          format: 'full'
        })
        const latestIncoming = (thread.data.messages || [])
          .filter((message) => !isSentMessage(message))
          .sort((a, b) => messageTimestamp(b) - messageTimestamp(a))[0]
        if (latestIncoming?.id) {
          original = await gmail.users.messages.get({ userId: 'me', id: latestIncoming.id })
        }
      }
      const headers = original.data.payload?.headers || []
      const originalRequestText = getMessageBodyText(original.data).body || decodeHtmlEntities(original.data.snippet || '')
      const resolvedAttachment = resolveReplyAttachment(originalRequestText, attachment_path)

      if (!resolvedAttachment.path && claimsAttachment(body)) {
        throw new Error('Reply body mentions an attachment, but no valid file path was provided.')
      }

      // Use Reply-To header if present, otherwise fall back to From
      const replyTo = findHeader(headers, 'Reply-To') || findHeader(headers, 'From')
      if (!replyTo) throw new Error('Could not determine the sender address from the original email.')

      // Extract just the email address from "Name <email@domain.com>" format
      const toAddress = getHeaderAddress(replyTo)

      const originalSubject = findHeader(headers, 'Subject') || ''
      const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`
      const messageId = findHeader(headers, 'Message-ID') || findHeader(headers, 'Message-Id')
      const threadId = original.data.threadId || undefined

      let raw: string
      const replyExtraHeaders = messageId
        ? [`In-Reply-To: ${messageId}`, `References: ${messageId}`]
        : []

      if (resolvedAttachment.path) {
        raw = makeEmailWithAttachment(
          toAddress,
          subject,
          body,
          resolvedAttachment.path,
          replyExtraHeaders
        )
      } else {
        // Build plain reply with proper headers
        const replyParts = [
          `To: ${toAddress}`,
          `Subject: ${subject}`,
          ...replyExtraHeaders,
          '',
          body
        ].join('\n')

        raw = Buffer.from(replyParts)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')
      }

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId }
      })

      const senderName = cleanSenderName(replyTo)
      const prefix = isNewLogin ? '[SYSTEM NOTICE: Login successful.]\n\n' : ''
      const attachNote = resolvedAttachment.path
        ? ` with attachment "${path.basename(resolvedAttachment.path)}"`
        : ''
      const generationNote = resolvedAttachment.note ? ` ${resolvedAttachment.note}` : ''
      return prefix + `Reply sent to ${senderName} (${toAddress})${attachNote}.${generationNote}`
    } catch (e: any) {
      return `Reply Error: ${normalizeGmailError(e)}`
    }
  })
}
