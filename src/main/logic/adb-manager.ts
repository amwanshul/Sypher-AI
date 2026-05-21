// Uses Electron IPC plus timed ADB child processes so phone control stays local and non-blocking.
import { BrowserWindow, IpcMain, app } from 'electron'
import { execFile } from 'child_process'
import util from 'util'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import Groq from 'groq-sdk'

const execFileAsync = util.promisify(execFile)

type DeviceTransport = 'usb' | 'wifi'
type DeviceStatus = 'device' | 'unauthorized' | 'offline' | 'unknown'
type PhoneActionName = 'send_message' | 'screenshot' | 'open_app' | 'media_control' | 'call'
type MediaCommand = 'play' | 'pause' | 'next' | 'search' | null

interface DeviceRecord {
  serial: string
  status: DeviceStatus
  transport: DeviceTransport
  model?: string
  product?: string
  authorized: boolean
}

interface ActiveDevice {
  serial: string
  transport: DeviceTransport
  ip?: string
  port?: string
  model?: string
  lastSeen: number
}

interface PhoneAction {
  action: PhoneActionName
  app: string | null
  contact: string | null
  message: string | null
  media_cmd: MediaCommand
  query: string | null
}

interface PhoneActionResult {
  success: boolean
  speechText: string
  data?: any
  error?: string
}

class AdbUnavailableError extends Error {
  constructor() {
    super(
      'ADB is not installed. Install Android Platform Tools, add the platform-tools folder to PATH, then restart Sypher.'
    )
    this.name = 'AdbUnavailableError'
  }
}

const ADB_TIMEOUT_MS = 8000
const ADB_LONG_TIMEOUT_MS = 15000
const SCREENSHOT_MAX_BUFFER = 1024 * 1024 * 25
const DEFAULT_COUNTRY_CODE = process.env.SYPHER_PHONE_COUNTRY_CODE || ''

const DEFAULT_APP_PACKAGES: Record<string, string> = {
  brave: 'com.brave.browser',
  browser: 'com.android.chrome',
  calculator: 'com.google.android.calculator',
  camera: 'android.media.action.STILL_IMAGE_CAMERA',
  chrome: 'com.android.chrome',
  dialer: 'com.google.android.dialer',
  drive: 'com.google.android.apps.docs',
  files: 'com.google.android.documentsui',
  gallery: 'com.google.android.apps.photos',
  gmail: 'com.google.android.gm',
  google: 'com.google.android.googlequicksearchbox',
  instagram: 'com.instagram.android',
  maps: 'com.google.android.apps.maps',
  messages: 'com.google.android.apps.messaging',
  phone: 'com.google.android.dialer',
  photos: 'com.google.android.apps.photos',
  settings: 'com.android.settings',
  spotify: 'com.spotify.music',
  telegram: 'org.telegram.messenger',
  whatsapp: 'com.whatsapp',
  'whatsapp business': 'com.whatsapp.w4b',
  youtube: 'com.google.android.youtube'
}

let adbPathCache: string | null = null
let activeDevice: ActiveDevice | null = null
let monitorTimer: NodeJS.Timeout | null = null
let monitorBusy = false
let reportedAdbMissing = false

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const dataDir = () => path.join(app.getPath('userData'), 'Phone Control')
const contactsPath = () => path.join(dataDir(), 'contacts.json')
const appMapPath = () => path.join(dataDir(), 'app-packages.json')
const historyDir = () => path.join(app.getPath('userData'), 'Connected Devices')
const historyPath = () => path.join(historyDir(), 'Connect-mobile.json')
const screenshotsDir = () => path.join(app.getPath('userData'), 'Phone Control', 'screenshots')

function pushPhoneEvent(payload: Record<string, any>) {
  const event = {
    timestamp: new Date().toISOString(),
    ...payload
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('phone-dashboard-event', event)
  }
}

function normalizeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePhoneNumber(value: string) {
  let digits = value.trim().replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  if (digits.length === 10 && DEFAULT_COUNTRY_CODE) digits = `${DEFAULT_COUNTRY_CODE}${digits}`
  return digits
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }

  return previous[b.length]
}

function similarity(a: string, b: string) {
  const left = normalizeKey(a)
  const right = normalizeKey(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return 0.92
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

async function ensureDataStores() {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.mkdir(screenshotsDir(), { recursive: true })

  if (!fs.existsSync(contactsPath())) {
    await fsp.writeFile(contactsPath(), JSON.stringify({}, null, 2), 'utf-8')
  }

  if (!fs.existsSync(appMapPath())) {
    await fsp.writeFile(appMapPath(), JSON.stringify(DEFAULT_APP_PACKAGES, null, 2), 'utf-8')
  }
}

async function loadJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    await ensureDataStores()
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function saveJson(filePath: string, data: any) {
  await ensureDataStores()
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function loadContacts() {
  return loadJson<Record<string, string>>(contactsPath(), {})
}

async function loadAppPackages() {
  const stored = await loadJson<Record<string, string>>(appMapPath(), DEFAULT_APP_PACKAGES)
  return { ...DEFAULT_APP_PACKAGES, ...stored }
}

async function runProcess(
  file: string,
  args: string[],
  timeoutMs = ADB_TIMEOUT_MS,
  maxBuffer = 1024 * 1024 * 4
) {
  try {
    const result = (await execFileAsync(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
      encoding: 'utf8'
    } as any)) as { stdout: string | Buffer; stderr: string | Buffer }

    return {
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout || '',
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr || ''
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new AdbUnavailableError()

    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString('utf8')
      : String(error?.stderr || '')
    const stdout = Buffer.isBuffer(error?.stdout)
      ? error.stdout.toString('utf8')
      : String(error?.stdout || '')
    const message = [stderr, stdout, error?.message].filter(Boolean).join('\n').trim()
    throw new Error(message || 'ADB command failed.')
  }
}

async function runProcessBuffer(
  file: string,
  args: string[],
  timeoutMs = ADB_TIMEOUT_MS,
  maxBuffer = SCREENSHOT_MAX_BUFFER
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: 'buffer' } as any,
      (error, stdout, stderr) => {
        if (error) {
          if ((error as any)?.code === 'ENOENT') reject(new AdbUnavailableError())
          else reject(new Error(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : error.message))
          return
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''))
      }
    )
  })
}

async function resolveAdbPath() {
  if (adbPathCache) return adbPathCache

  const candidates = [
    process.env.ADB_PATH,
    process.env.ANDROID_HOME
      ? path.join(process.env.ANDROID_HOME, 'platform-tools', os.platform() === 'win32' ? 'adb.exe' : 'adb')
      : '',
    process.env.ANDROID_SDK_ROOT
      ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', os.platform() === 'win32' ? 'adb.exe' : 'adb')
      : '',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')
      : '',
    os.platform() === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb')
      : '',
    'adb'
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      if (candidate !== 'adb' && !fs.existsSync(candidate)) continue
      await runProcess(candidate, ['version'], 3000)
      adbPathCache = candidate
      return candidate
    } catch (error) {
      continue
    }
  }

  throw new AdbUnavailableError()
}

async function runAdb(args: string[], timeoutMs = ADB_TIMEOUT_MS, maxBuffer?: number) {
  const adbPath = await resolveAdbPath()
  return runProcess(adbPath, args, timeoutMs, maxBuffer)
}

async function runAdbBuffer(args: string[], timeoutMs = ADB_TIMEOUT_MS, maxBuffer?: number) {
  const adbPath = await resolveAdbPath()
  return runProcessBuffer(adbPath, args, timeoutMs, maxBuffer)
}

async function adbShell(serial: string, args: string[], timeoutMs = ADB_TIMEOUT_MS) {
  return runAdb(['-s', serial, 'shell', ...args], timeoutMs)
}

async function adbShellCommand(serial: string, command: string, timeoutMs = ADB_TIMEOUT_MS) {
  return runAdb(['-s', serial, 'shell', command], timeoutMs)
}

function parseDeviceLine(line: string): DeviceRecord | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('List of devices')) return null

  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) return null

  const serial = parts[0]
  const status = ['device', 'unauthorized', 'offline'].includes(parts[1])
    ? (parts[1] as DeviceStatus)
    : 'unknown'
  const modelToken = parts.find((part) => part.startsWith('model:'))
  const productToken = parts.find((part) => part.startsWith('product:'))

  return {
    serial,
    status,
    transport: serial.includes(':') ? 'wifi' : 'usb',
    model: modelToken ? modelToken.replace(/^model:/, '').replace(/_/g, ' ') : undefined,
    product: productToken ? productToken.replace(/^product:/, '') : undefined,
    authorized: status === 'device'
  }
}

async function listDevices(): Promise<DeviceRecord[]> {
  const { stdout } = await runAdb(['devices', '-l'], ADB_TIMEOUT_MS)
  return stdout
    .split(/\r?\n/)
    .map(parseDeviceLine)
    .filter((device): device is DeviceRecord => Boolean(device))
}

async function getDeviceModel(serial: string) {
  try {
    const { stdout } = await adbShell(serial, ['getprop', 'ro.product.model'], 4000)
    return stdout.trim().toUpperCase() || 'ANDROID DEVICE'
  } catch {
    return 'ANDROID DEVICE'
  }
}

async function setActiveDevice(device: DeviceRecord | ActiveDevice, notify = true) {
  const previousSerial = activeDevice?.serial
  const serial = device.serial
  const model = device.model || (await getDeviceModel(serial))

  activeDevice = {
    serial,
    transport: device.transport,
    ip: serial.includes(':') ? serial.split(':')[0] : undefined,
    port: serial.includes(':') ? serial.split(':')[1] : undefined,
    model,
    lastSeen: Date.now()
  }

  if (notify && previousSerial !== serial) {
    pushPhoneEvent({
      type: 'phone_connection',
      action: 'connected',
      device: { serial, model, transport: activeDevice.transport }
    })
  }

  return activeDevice
}

async function saveDeviceToHistory(ip: string, port: string, model: string) {
  try {
    await fsp.mkdir(historyDir(), { recursive: true })
    let history: any[] = []
    try {
      history = JSON.parse(await fsp.readFile(historyPath(), 'utf-8'))
    } catch {}

    const deviceData = { ip, port, model, lastConnected: new Date().toISOString() }
    const existingIndex = history.findIndex((device) => device.ip === ip && device.port === port)
    if (existingIndex >= 0) history[existingIndex] = deviceData
    else history.push(deviceData)

    await fsp.writeFile(historyPath(), JSON.stringify(history, null, 2), 'utf-8')
  } catch {}
}

async function connectWifiDevice(ip: string, port: string) {
  const target = `${ip}:${port}`
  const { stdout, stderr } = await runAdb(['connect', target], ADB_LONG_TIMEOUT_MS)
  const output = `${stdout}\n${stderr}`.toLowerCase()

  if (output.includes('unauthorized')) {
    throw new Error('Phone detected but not authorized. Accept the USB debugging prompt on the phone.')
  }

  if (!output.includes('connected to') && !output.includes('already connected')) {
    throw new Error(stdout.trim() || stderr.trim() || 'ADB WiFi connection failed.')
  }

  const device = await setActiveDevice({ serial: target, status: 'device', transport: 'wifi', authorized: true })
  await saveDeviceToHistory(ip, port, device.model || 'ANDROID DEVICE')
  return device
}

async function ensureConnected() {
  try {
    await resolveAdbPath()
  } catch (error) {
    if (!reportedAdbMissing) {
      reportedAdbMissing = true
      pushPhoneEvent({
        type: 'phone_error',
        action: 'adb_missing',
        error: (error as Error).message,
        speak: 'ADB is not installed. Install Android Platform Tools and add platform-tools to PATH.'
      })
    }
    throw error
  }

  const devices = await listDevices()
  const authorized = devices.filter((device) => device.authorized)

  if (activeDevice) {
    const current = authorized.find((device) => device.serial === activeDevice?.serial)
    if (current) return setActiveDevice(current, false)

    if (activeDevice.transport === 'wifi' && activeDevice.ip && activeDevice.port) {
      try {
        return await connectWifiDevice(activeDevice.ip, activeDevice.port)
      } catch {}
    }
  }

  if (authorized.length > 0) return setActiveDevice(authorized[0])

  const unauthorized = devices.find((device) => device.status === 'unauthorized')
  if (unauthorized) {
    throw new Error('Phone detected but not authorized. Accept the USB debugging prompt on the phone.')
  }

  throw new Error('Phone not connected. Connect with USB debugging or use the Phone tab for WiFi ADB.')
}

async function monitorConnection() {
  if (monitorBusy) return
  monitorBusy = true

  try {
    const devices = await listDevices()
    const authorized = devices.filter((device) => device.authorized)

    if (activeDevice) {
      const stillPresent = authorized.find((device) => device.serial === activeDevice?.serial)
      if (stillPresent) {
        activeDevice.lastSeen = Date.now()
        return
      }

      if (activeDevice.transport === 'wifi' && activeDevice.ip && activeDevice.port) {
        try {
          await connectWifiDevice(activeDevice.ip, activeDevice.port)
          return
        } catch {}
      }

      const disconnected = activeDevice
      activeDevice = null
      pushPhoneEvent({
        type: 'phone_connection',
        action: 'disconnected',
        device: disconnected,
        speak: 'Phone disconnected.'
      })
      return
    }

    if (authorized.length > 0) {
      await setActiveDevice(authorized[0])
    }
  } catch (error: any) {
    if (error instanceof AdbUnavailableError && !reportedAdbMissing) {
      reportedAdbMissing = true
      pushPhoneEvent({
        type: 'phone_error',
        action: 'adb_missing',
        error: error.message,
        speak: 'ADB is not installed. Install Android Platform Tools and add platform-tools to PATH.'
      })
    }
  } finally {
    monitorBusy = false
  }
}

function startConnectionMonitor() {
  if (monitorTimer) return
  monitorTimer = setInterval(() => {
    void monitorConnection()
  }, 5000)
}

function fallbackPhoneIntent(command: string): PhoneAction {
  const text = command.trim()
  const lower = text.toLowerCase()

  if (/\b(screen\s*shot|screenshot|capture my phone|capture phone)\b/.test(lower)) {
    return {
      action: 'screenshot',
      app: null,
      contact: null,
      message: null,
      media_cmd: null,
      query: null
    }
  }

  const callMatch = text.match(/\bcall\s+(.+?)(?:\s+on\s+(?:my\s+)?phone)?$/i)
  if (callMatch) {
    return {
      action: 'call',
      app: 'phone',
      contact: callMatch[1].trim(),
      message: null,
      media_cmd: null,
      query: null
    }
  }

  const directMessageMatch = text.match(
    /\b(?:send\s+(?:a\s+)?whatsapp|send\s+whatsapp|whatsapp|text|message)\s+(?:to\s+)?(.+?)(?:,|\s+saying\s+|\s+that\s+|\s+message\s+)(.+)$/i
  )
  const genericSendMatch = text.match(
    /\bsend\s+(.+?)\s+(?:to|for)\s+(.+?)(?:\s+on\s+(?:my\s+)?(?:phone|mobile|whatsapp))?$/i
  )
  const trailingWhatsAppMatch = text.match(
    /\bsend\s+(.+?)\s+on\s+whatsapp\s+(?:on\s+(?:my\s+)?phone\s+)?to\s+(.+?)$/i
  )
  const textMessageMatch = text.match(/\btext\s+(.+?)\s+(.+)$/i)

  if (directMessageMatch || genericSendMatch || trailingWhatsAppMatch || textMessageMatch) {
    const contact =
      directMessageMatch?.[1] ||
      trailingWhatsAppMatch?.[2] ||
      genericSendMatch?.[2] ||
      textMessageMatch?.[1] ||
      ''
    const message =
      directMessageMatch?.[2] ||
      trailingWhatsAppMatch?.[1] ||
      genericSendMatch?.[1] ||
      textMessageMatch?.[2] ||
      ''

    return {
      action: 'send_message',
      app: lower.includes('sms') ? 'messages' : 'whatsapp',
      contact: contact.trim(),
      message: message.trim(),
      media_cmd: null,
      query: null
    }
  }

  if (/\b(next|skip)\b.*\b(song|track|music|spotify|media)\b/.test(lower)) {
    return {
      action: 'media_control',
      app: lower.includes('spotify') ? 'spotify' : null,
      contact: null,
      message: null,
      media_cmd: 'next',
      query: null
    }
  }

  if (/\b(pause|stop)\b.*\b(song|track|music|spotify|media)\b/.test(lower)) {
    return {
      action: 'media_control',
      app: lower.includes('spotify') ? 'spotify' : null,
      contact: null,
      message: null,
      media_cmd: 'pause',
      query: null
    }
  }

  const playMatch = text.match(/\bplay\s+(.+?)(?:\s+on\s+([a-z0-9 ._-]+))?$/i)
  if (playMatch) {
    return {
      action: 'media_control',
      app: playMatch[2]?.trim() || (lower.includes('spotify') ? 'spotify' : null),
      contact: null,
      message: null,
      media_cmd: playMatch[1]?.trim() ? 'search' : 'play',
      query: playMatch[1]?.trim() || null
    }
  }

  const openMatch = text.match(/\bopen\s+(.+?)(?:\s+on\s+(?:my\s+)?phone|\s+on\s+mobile)?$/i)
  if (openMatch) {
    return {
      action: 'open_app',
      app: openMatch[1].trim(),
      contact: null,
      message: null,
      media_cmd: null,
      query: null
    }
  }

  return {
    action: 'open_app',
    app: text,
    contact: null,
    message: null,
    media_cmd: null,
    query: null
  }
}

function normalizePhoneAction(raw: any): PhoneAction {
  const actions = new Set<PhoneActionName>([
    'send_message',
    'screenshot',
    'open_app',
    'media_control',
    'call'
  ])
  const mediaCommands = new Set(['play', 'pause', 'next', 'search'])

  const action = actions.has(raw?.action) ? raw.action : 'open_app'
  const media_cmd = mediaCommands.has(raw?.media_cmd) ? raw.media_cmd : null

  return {
    action,
    app: typeof raw?.app === 'string' && raw.app.trim() ? raw.app.trim() : null,
    contact: typeof raw?.contact === 'string' && raw.contact.trim() ? raw.contact.trim() : null,
    message: typeof raw?.message === 'string' && raw.message.trim() ? raw.message.trim() : null,
    media_cmd,
    query: typeof raw?.query === 'string' && raw.query.trim() ? raw.query.trim() : null
  }
}

async function parsePhoneIntent(command: string, groqKey?: string): Promise<PhoneAction> {
  const fallback = fallbackPhoneIntent(command)
  if (!groqKey?.trim()) return fallback

  try {
    const groq = new Groq({ apiKey: groqKey.trim() })
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'Extract Android phone control intent. Return only valid JSON.',
            'Fields: action one of send_message, screenshot, open_app, media_control, call; app string or null; contact string or null; message string or null; media_cmd one of play, pause, next, search or null; query string or null.',
            'For WhatsApp/text commands, action is send_message, app is whatsapp unless SMS is explicit.',
            'For "play X on Spotify", action is media_control, app is spotify, media_cmd is search, query is X.',
            'For "take a screenshot of my phone", action is screenshot.'
          ].join('\n')
        },
        { role: 'user', content: command }
      ]
    })

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}')
    return normalizePhoneAction({ ...fallback, ...parsed })
  } catch {
    return fallback
  }
}

async function resolveContact(contact: string | null) {
  if (!contact?.trim()) {
    return { success: false, error: 'No contact provided.', contact: '', number: '' }
  }

  const directNumber = normalizePhoneNumber(contact)
  if (/^\d{5,15}$/.test(directNumber)) {
    return { success: true, contact, number: directNumber, confidence: 1 }
  }

  const contacts = await loadContacts()
  const entries = Object.entries(contacts).filter(([, number]) => normalizePhoneNumber(number).length > 0)
  const exact = entries.find(([name]) => normalizeKey(name) === normalizeKey(contact))

  if (exact) {
    return {
      success: true,
      contact: exact[0],
      number: normalizePhoneNumber(exact[1]),
      confidence: 1
    }
  }

  let best: { name: string; number: string; score: number } | null = null
  for (const [name, number] of entries) {
    const score = similarity(contact, name)
    if (!best || score > best.score) best = { name, number: normalizePhoneNumber(number), score }
  }

  if (best && best.score >= 0.72) {
    return {
      success: true,
      contact: best.name,
      number: best.number,
      confidence: best.score
    }
  }

  return {
    success: false,
    contact,
    number: '',
    error: `I do not have a phone number for ${contact}. Add it in contacts.json from the Phone Control data folder, or tell me the number so I can save it.`
  }
}

async function resolveAppPackage(serial: string, appName: string | null) {
  if (!appName?.trim()) return null

  const cleanApp = appName.trim()
  if (cleanApp === 'android.media.action.STILL_IMAGE_CAMERA') return cleanApp
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(cleanApp)) return cleanApp

  const normalized = normalizeKey(cleanApp)
  const packageMap = await loadAppPackages()
  const direct = packageMap[normalized] || packageMap[cleanApp.toLowerCase()]
  if (direct) return direct

  try {
    const { stdout } = await adbShell(serial, ['pm', 'list', 'packages'], ADB_LONG_TIMEOUT_MS)
    const packages = stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean)
    const compactApp = normalized.replace(/\s+/g, '')

    return (
      packages.find((pkg) => normalizeKey(pkg).replace(/\s+/g, '').includes(compactApp)) || null
    )
  } catch {
    return null
  }
}

async function waitForPackage(serial: string, packageName: string, timeoutMs = 12000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { stdout } = await adbShell(serial, ['dumpsys', 'window', 'windows'], 4000)
      if (stdout.includes(packageName)) return true
    } catch {
      try {
        const { stdout } = await adbShell(serial, ['dumpsys', 'activity', 'activities'], 4000)
        if (stdout.includes(packageName)) return true
      } catch {}
    }
    await sleep(700)
  }
  return false
}

async function launchPackage(serial: string, packageName: string, appLabel = packageName) {
  if (packageName === 'android.media.action.STILL_IMAGE_CAMERA') {
    await adbShell(serial, ['am', 'start', '-W', '-a', 'android.media.action.STILL_IMAGE_CAMERA'], ADB_LONG_TIMEOUT_MS)
    return { packageName, label: 'Camera' }
  }

  await runAdb(
    ['-s', serial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
    ADB_LONG_TIMEOUT_MS
  )
  await waitForPackage(serial, packageName, 10000)
  return { packageName, label: appLabel }
}

async function captureStreamScreenshot(serial: string) {
  const image = await runAdbBuffer(
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    ADB_LONG_TIMEOUT_MS,
    SCREENSHOT_MAX_BUFFER
  )
  return `data:image/png;base64,${image.toString('base64')}`
}

async function captureDashboardScreenshot(serial: string): Promise<PhoneActionResult> {
  await fsp.mkdir(screenshotsDir(), { recursive: true })
  const fileName = `phone-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  const remotePath = `/sdcard/Sypher/${fileName}`
  const localPath = path.join(screenshotsDir(), fileName)

  await adbShell(serial, ['mkdir', '-p', '/sdcard/Sypher'], 5000)
  await adbShell(serial, ['screencap', '-p', remotePath], ADB_LONG_TIMEOUT_MS)
  await runAdb(['-s', serial, 'pull', remotePath, localPath], ADB_LONG_TIMEOUT_MS)

  const image = `data:image/png;base64,${(await fsp.readFile(localPath)).toString('base64')}`
  pushPhoneEvent({
    type: 'phone_screenshot',
    action: 'screenshot_captured',
    image_path: localPath,
    image
  })

  return {
    success: true,
    speechText: `Phone screenshot saved to ${localPath}.`,
    data: { image_path: localPath, image }
  }
}

function parseAndroidContactRows(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const name = line.match(/display_name=([^,]+)/)?.[1]?.trim()
      const number = line.match(/(?:data1|number)=([^,]+)/)?.[1]?.trim()
      if (!name || !number) return null
      return { name, number: normalizePhoneNumber(number) }
    })
    .filter((contact): contact is { name: string; number: string } =>
      Boolean(contact?.name && contact?.number)
    )
}

async function resolveAndroidContact(serial: string, contactName: string) {
  try {
    const { stdout } = await adbShell(
      serial,
      [
        'content',
        'query',
        '--uri',
        'content://com.android.contacts/data/phones',
        '--projection',
        'display_name:data1'
      ],
      ADB_LONG_TIMEOUT_MS
    )

    const rows = parseAndroidContactRows(stdout)
    let best: { name: string; number: string; score: number } | null = null
    for (const row of rows) {
      const score = similarity(contactName, row.name)
      if (!best || score > best.score) best = { ...row, score }
    }

    if (best && best.score >= 0.72) {
      return {
        success: true,
        contact: best.name,
        number: best.number,
        confidence: best.score
      }
    }
  } catch {}

  return null
}

async function executeSendMessage(serial: string, action: PhoneAction): Promise<PhoneActionResult> {
  let contact = await resolveContact(action.contact)
  if (!contact.success && action.contact) {
    const androidContact = await resolveAndroidContact(serial, action.contact)
    if (androidContact?.success) contact = androidContact
  }
  if (!contact.success) {
    return { success: false, speechText: contact.error || 'Contact not found.', error: contact.error }
  }

  if (!action.message) {
    return {
      success: false,
      speechText: 'No message text was provided.',
      error: 'No message text was provided.'
    }
  }

  const appName = action.app || 'whatsapp'
  const packageName = await resolveAppPackage(serial, appName)
  if (!packageName) {
    return { success: false, speechText: `I could not resolve the Android package for ${appName}.` }
  }

  if (packageName !== 'com.whatsapp' && packageName !== 'com.whatsapp.w4b') {
    return {
      success: false,
      speechText: 'Automated message sending is currently limited to WhatsApp.'
    }
  }

  const deepLink = `https://wa.me/${contact.number}?text=${encodeURIComponent(action.message)}`
  await adbShell(
    serial,
    ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', deepLink, '-p', packageName],
    ADB_LONG_TIMEOUT_MS
  )
  await waitForPackage(serial, packageName, 12000)
  await sleep(1200)
  await adbShell(serial, ['input', 'keyevent', 'KEYCODE_ENTER'], 5000)

  pushPhoneEvent({
    type: 'phone_action',
    action: 'message_sent',
    app: appName,
    contact: contact.contact,
    preview: action.message
  })

  return {
    success: true,
    speechText: `Message sent to ${contact.contact}.`,
    data: { contact: contact.contact, preview: action.message }
  }
}

async function executeCall(serial: string, action: PhoneAction): Promise<PhoneActionResult> {
  let contact = await resolveContact(action.contact)
  if (!contact.success && action.contact) {
    const androidContact = await resolveAndroidContact(serial, action.contact)
    if (androidContact?.success) contact = androidContact
  }
  if (!contact.success) {
    return { success: false, speechText: contact.error || 'Contact not found.', error: contact.error }
  }

  try {
    await adbShell(
      serial,
      ['am', 'start', '-W', '-a', 'android.intent.action.CALL', '-d', `tel:${contact.number}`],
      ADB_LONG_TIMEOUT_MS
    )
  } catch {
    await adbShell(
      serial,
      ['am', 'start', '-W', '-a', 'android.intent.action.DIAL', '-d', `tel:${contact.number}`],
      ADB_LONG_TIMEOUT_MS
    )
  }

  pushPhoneEvent({
    type: 'phone_action',
    action: 'call_started',
    contact: contact.contact
  })

  return { success: true, speechText: `Calling ${contact.contact}.` }
}

async function getNowPlaying(serial: string) {
  try {
    const { stdout } = await adbShellCommand(serial, 'dumpsys media_session', 6000)
    const description = stdout.match(/description=(.*)/)?.[1]?.trim()
    const metadata = stdout.match(/metadata:.*?title=(.*?)(?:,|$)/s)?.[1]?.trim()
    return metadata || description || null
  } catch {
    return null
  }
}

async function executeMediaControl(serial: string, action: PhoneAction): Promise<PhoneActionResult> {
  const packageName = action.app ? await resolveAppPackage(serial, action.app) : null
  if (packageName && action.app) await launchPackage(serial, packageName, action.app)

  if (action.media_cmd === 'search' && action.query) {
    const query = action.query.trim()
    if (packageName === 'com.spotify.music') {
      await adbShell(
        serial,
        ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `spotify:search:${encodeURIComponent(query)}`],
        ADB_LONG_TIMEOUT_MS
      )
    } else if (packageName === 'com.google.android.youtube') {
      await adbShell(
        serial,
        ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`],
        ADB_LONG_TIMEOUT_MS
      )
    } else {
      await adbShell(serial, ['input', 'keyevent', 'KEYCODE_SEARCH'], 5000)
      await sleep(700)
      await adbShell(serial, ['input', 'text', query.replace(/\s+/g, '%s')], 5000)
      await adbShell(serial, ['input', 'keyevent', 'KEYCODE_ENTER'], 5000)
    }
  } else {
    const keyMap: Record<string, string> = {
      next: 'KEYCODE_MEDIA_NEXT',
      pause: 'KEYCODE_MEDIA_PAUSE',
      play: 'KEYCODE_MEDIA_PLAY'
    }
    const key = keyMap[action.media_cmd || 'play']
    await adbShell(serial, ['input', 'keyevent', key], 5000)
  }

  const nowPlaying = await getNowPlaying(serial)
  pushPhoneEvent({
    type: 'phone_action',
    action: 'media_control',
    app: action.app,
    media_cmd: action.media_cmd,
    query: action.query,
    nowPlaying
  })

  return {
    success: true,
    speechText: nowPlaying
      ? `Phone media command executed. Now playing: ${nowPlaying}.`
      : 'Phone media command executed.',
    data: { nowPlaying }
  }
}

async function executeOpenApp(serial: string, action: PhoneAction): Promise<PhoneActionResult> {
  const packageName = await resolveAppPackage(serial, action.app)
  if (!packageName) {
    return {
      success: false,
      speechText: `I could not find an installed Android app for ${action.app || 'that request'}.`
    }
  }

  await launchPackage(serial, packageName, action.app || packageName)
  pushPhoneEvent({
    type: 'phone_action',
    action: 'app_opened',
    app: action.app || packageName,
    packageName
  })

  return { success: true, speechText: `Opened ${action.app || packageName} on your phone.` }
}

async function executePhoneAction(action: PhoneAction): Promise<PhoneActionResult> {
  const device = await ensureConnected()

  if (action.action === 'screenshot') return captureDashboardScreenshot(device.serial)
  if (action.action === 'send_message') return executeSendMessage(device.serial, action)
  if (action.action === 'call') return executeCall(device.serial, action)
  if (action.action === 'media_control') return executeMediaControl(device.serial, action)
  return executeOpenApp(device.serial, action)
}

function formatActionError(error: any) {
  if (error instanceof AdbUnavailableError) return error.message
  return error?.message || String(error)
}

export default function registerAdbHandlers(ipcMain: IpcMain) {
  void ensureDataStores()
  startConnectionMonitor()

  ipcMain.removeHandler('adb-get-history')
  ipcMain.handle('adb-get-history', async () => {
    try {
      const file = await fsp.readFile(historyPath(), 'utf-8')
      return JSON.parse(file)
    } catch {
      return []
    }
  })

  ipcMain.removeHandler('adb-clear-history')
  ipcMain.handle('adb-clear-history', async () => {
    try {
      await fsp.mkdir(historyDir(), { recursive: true })
      await fsp.writeFile(historyPath(), JSON.stringify([], null, 2), 'utf-8')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-detect-devices')
  ipcMain.handle('adb-detect-devices', async () => {
    try {
      return { success: true, devices: await listDevices() }
    } catch (error: any) {
      return { success: false, error: formatActionError(error), devices: [] }
    }
  })

  ipcMain.removeHandler('adb-connect')
  ipcMain.handle('adb-connect', async (_, { ip, port }) => {
    try {
      const device = await connectWifiDevice(String(ip || '').trim(), String(port || '5555').trim())
      return { success: true, device }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-connect-usb')
  ipcMain.handle('adb-connect-usb', async () => {
    try {
      const device = await ensureConnected()
      return { success: true, device }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-disconnect')
  ipcMain.handle('adb-disconnect', async () => {
    try {
      const disconnected = activeDevice
      if (activeDevice?.transport === 'wifi') {
        await runAdb(['disconnect', activeDevice.serial], ADB_TIMEOUT_MS).catch(() => null)
      }
      activeDevice = null
      if (disconnected) {
        pushPhoneEvent({
          type: 'phone_connection',
          action: 'disconnected',
          device: disconnected,
          speak: 'Phone disconnected.'
        })
      }
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-shell-command')
  ipcMain.handle('adb-shell-command', async (_, { command, timeoutMs }) => {
    try {
      const device = await ensureConnected()
      const result = await adbShellCommand(device.serial, String(command || ''), Number(timeoutMs) || ADB_TIMEOUT_MS)
      return { success: true, stdout: result.stdout, stderr: result.stderr }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-parse-phone-intent')
  ipcMain.handle('adb-parse-phone-intent', async (_, { command, groqKey }) => {
    try {
      return { success: true, intent: await parsePhoneIntent(String(command || ''), groqKey) }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-execute-phone-action')
  ipcMain.handle('adb-execute-phone-action', async (_, { command, action, groqKey }) => {
    try {
      const intent = action ? normalizePhoneAction(action) : await parsePhoneIntent(String(command || ''), groqKey)
      const result = await executePhoneAction(intent)
      return { ...result, intent }
    } catch (error: any) {
      const speechText = formatActionError(error)
      pushPhoneEvent({
        type: 'phone_error',
        action: 'phone_action_failed',
        error: speechText
      })
      return { success: false, speechText, error: speechText }
    }
  })

  ipcMain.removeHandler('adb-get-contacts')
  ipcMain.handle('adb-get-contacts', async () => {
    try {
      return { success: true, contacts: await loadContacts(), path: contactsPath() }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-save-contact')
  ipcMain.handle('adb-save-contact', async (_, { name, number }) => {
    try {
      const contacts = await loadContacts()
      contacts[String(name || '').trim()] = normalizePhoneNumber(String(number || ''))
      await saveJson(contactsPath(), contacts)
      return { success: true, contacts, path: contactsPath() }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-get-app-package-map')
  ipcMain.handle('adb-get-app-package-map', async () => {
    try {
      return { success: true, apps: await loadAppPackages(), path: appMapPath() }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-screenshot')
  ipcMain.handle('adb-screenshot', async () => {
    try {
      const device = await ensureConnected()
      const image = await captureStreamScreenshot(device.serial)
      return { success: true, image }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-quick-action')
  ipcMain.handle('adb-quick-action', async (_, { action }) => {
    try {
      const device = await ensureConnected()
      const quickAction = String(action || '').toLowerCase()

      if (quickAction === 'camera') {
        await launchPackage(device.serial, 'android.media.action.STILL_IMAGE_CAMERA', 'Camera')
      } else if (quickAction === 'wake') {
        await adbShell(device.serial, ['input', 'keyevent', 'KEYCODE_WAKEUP'], 5000)
      } else if (quickAction === 'lock') {
        await adbShell(device.serial, ['input', 'keyevent', 'KEYCODE_SLEEP'], 5000)
      } else if (quickAction === 'home') {
        await adbShell(device.serial, ['input', 'keyevent', 'KEYCODE_HOME'], 5000)
      } else {
        return { success: false, error: 'Invalid quick action.' }
      }

      pushPhoneEvent({ type: 'phone_action', action: `quick_${quickAction}` })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-telemetry')
  ipcMain.handle('adb-telemetry', async () => {
    try {
      const device = await ensureConnected()
      const { stdout: batteryOut } = await adbShell(device.serial, ['dumpsys', 'battery'], ADB_TIMEOUT_MS)
      const levelMatch = batteryOut.match(/level: (\d+)/)
      const tempMatch = batteryOut.match(/temperature: (\d+)/)
      const isCharging =
        batteryOut.includes('AC powered: true') || batteryOut.includes('USB powered: true')

      const level = levelMatch ? Number(levelMatch[1]) : 0
      const temp = tempMatch ? (Number(tempMatch[1]) / 10).toFixed(1) : '0.0'

      const { stdout: storageOut } = await adbShell(device.serial, ['df', '-h', '/data'], ADB_TIMEOUT_MS)
      const storageLines = storageOut.trim().split('\n')
      let storageUsed = '0'
      let storageTotal = '0'
      let storagePercent = 0

      if (storageLines.length > 1) {
        const parts = storageLines[1].trim().split(/\s+/)
        storageTotal = parts[1] || '0'
        storageUsed = parts[2] || '0'
        storagePercent = Number((parts[4] || '0').replace('%', '')) || 0
      }

      const { stdout: modelOut } = await adbShell(device.serial, ['getprop', 'ro.product.model'], 5000)
      const { stdout: osOut } = await adbShell(device.serial, ['getprop', 'ro.build.version.release'], 5000)

      return {
        success: true,
        data: {
          model: modelOut.trim().toUpperCase() || device.model || 'ANDROID DEVICE',
          os: `ANDROID ${osOut.trim() || '--'}`,
          battery: { level, isCharging, temp },
          storage: { used: storageUsed, total: storageTotal, percent: storagePercent }
        }
      }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('get-mobile-info-ai')
  ipcMain.handle('get-mobile-info-ai', async () => {
    try {
      const device = await ensureConnected()
      const { stdout: batOut } = await adbShell(device.serial, ['dumpsys', 'battery'], ADB_TIMEOUT_MS)
      const level = batOut.match(/level: (\d+)/)?.[1] || 'Unknown'
      const { stdout: modelOut } = await adbShell(device.serial, ['getprop', 'ro.product.model'], 5000)
      return `I am linked to your ${modelOut.trim() || 'Android phone'}. Battery is at ${level}%.`
    } catch (error: any) {
      return formatActionError(error)
    }
  })

  ipcMain.removeHandler('adb-open-app')
  ipcMain.handle('adb-open-app', async (_, { packageName }) => {
    try {
      const device = await ensureConnected()
      const targetPackage = await resolveAppPackage(device.serial, String(packageName || ''))
      if (!targetPackage) return { success: false, error: 'App package could not be resolved.' }
      await launchPackage(device.serial, targetPackage, String(packageName || targetPackage))
      pushPhoneEvent({
        type: 'phone_action',
        action: 'app_opened',
        app: packageName,
        packageName: targetPackage
      })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-close-app')
  ipcMain.handle('adb-close-app', async (_, { packageName }) => {
    try {
      const device = await ensureConnected()
      const targetPackage = await resolveAppPackage(device.serial, String(packageName || ''))
      if (!targetPackage || targetPackage === 'android.media.action.STILL_IMAGE_CAMERA') {
        return { success: false, error: 'App package could not be resolved.' }
      }
      await adbShell(device.serial, ['am', 'force-stop', targetPackage], ADB_TIMEOUT_MS)
      pushPhoneEvent({
        type: 'phone_action',
        action: 'app_closed',
        app: packageName,
        packageName: targetPackage
      })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-tap')
  ipcMain.handle('adb-tap', async (_, { xPercent, yPercent }) => {
    try {
      const device = await ensureConnected()
      const { stdout } = await adbShell(device.serial, ['wm', 'size'], 5000)
      const match = stdout.match(/(\d+)x(\d+)/)
      if (!match) return { success: false, error: 'Could not read phone screen size.' }

      const width = Number(match[1])
      const height = Number(match[2])
      const x = Math.round((Number(xPercent) / 100) * width)
      const y = Math.round((Number(yPercent) / 100) * height)

      await adbShell(device.serial, ['input', 'tap', String(x), String(y)], 5000)
      pushPhoneEvent({ type: 'phone_action', action: 'tap', xPercent, yPercent })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-swipe')
  ipcMain.handle('adb-swipe', async (_, { direction }) => {
    try {
      const device = await ensureConnected()
      const { stdout } = await adbShell(device.serial, ['wm', 'size'], 5000)
      const match = stdout.match(/(\d+)x(\d+)/)
      if (!match) return { success: false, error: 'Could not read phone screen size.' }

      const width = Number(match[1])
      const height = Number(match[2])
      const cx = Math.round(width / 2)
      const cy = Math.round(height / 2)
      const cleanDirection = String(direction || '').toLowerCase()

      const swipes: Record<string, string[]> = {
        up: [String(cx), String(Math.round(height * 0.72)), String(cx), String(Math.round(height * 0.28)), '300'],
        down: [String(cx), String(Math.round(height * 0.28)), String(cx), String(Math.round(height * 0.72)), '300'],
        left: [String(Math.round(width * 0.82)), String(cy), String(Math.round(width * 0.18)), String(cy), '300'],
        right: [String(Math.round(width * 0.18)), String(cy), String(Math.round(width * 0.82)), String(cy), '300']
      }

      const swipe = swipes[cleanDirection]
      if (!swipe) return { success: false, error: 'Invalid swipe direction.' }

      await adbShell(device.serial, ['input', 'swipe', ...swipe], 5000)
      pushPhoneEvent({ type: 'phone_action', action: 'swipe', direction: cleanDirection })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-get-notifications')
  ipcMain.handle('adb-get-notifications', async () => {
    try {
      const device = await ensureConnected()
      const { stdout } = await adbShell(device.serial, ['dumpsys', 'notification', '--noredact'], ADB_LONG_TIMEOUT_MS)
      const notifications: string[] = []
      const lines = stdout.split('\n')
      let currentTitle = ''

      for (const line of lines) {
        if (line.includes('android.title=')) {
          const match = line.match(/android\.title=(?:String|CharSequence) \((.*?)\)/)
          if (match?.[1]) currentTitle = match[1].trim()
        } else if (line.includes('android.text=')) {
          const match = line.match(/android\.text=(?:String|CharSequence) \((.*?)\)/)
          if (!match?.[1]) continue

          const currentText = match[1].trim()
          const isSystem =
            currentTitle.toLowerCase().includes('running') ||
            currentTitle.toLowerCase().includes('sync') ||
            currentText.toLowerCase().includes('running')

          if (currentTitle && currentText && !isSystem) {
            const fullMessage = `Phone notification from ${currentTitle}: ${currentText}`
            if (!notifications.includes(fullMessage)) notifications.push(fullMessage)
            currentTitle = ''
          }
        }
      }

      return { success: true, data: notifications }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-push-file')
  ipcMain.handle('adb-push-file', async (_, { sourcePath, destPath = '/sdcard/Download/' }) => {
    try {
      const device = await ensureConnected()
      await runAdb(['-s', device.serial, 'push', String(sourcePath), String(destPath)], ADB_LONG_TIMEOUT_MS)
      pushPhoneEvent({
        type: 'phone_action',
        action: 'file_pushed',
        sourcePath,
        destPath
      })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-pull-file')
  ipcMain.handle('adb-pull-file', async (_, { sourcePath, destPath }) => {
    try {
      const device = await ensureConnected()
      const finalDest = destPath || app.getPath('downloads')
      await runAdb(['-s', device.serial, 'pull', String(sourcePath), String(finalDest)], ADB_LONG_TIMEOUT_MS)
      pushPhoneEvent({
        type: 'phone_action',
        action: 'file_pulled',
        sourcePath,
        destPath: finalDest
      })
      return { success: true, savedTo: finalDest }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })

  ipcMain.removeHandler('adb-hardware-toggle')
  ipcMain.handle('adb-hardware-toggle', async (_, { setting, state }) => {
    try {
      const device = await ensureConnected()
      const cleanSetting = String(setting || '').toLowerCase().trim()
      const action = state ? 'enable' : 'disable'

      if (cleanSetting === 'bluetooth' || cleanSetting === 'bt') {
        try {
          await adbShell(device.serial, ['svc', 'bluetooth', action], 5000)
        } catch {
          await adbShell(device.serial, ['cmd', 'bluetooth_manager', action], 5000)
        }
      } else if (cleanSetting === 'wifi') {
        try {
          await adbShell(device.serial, ['svc', 'wifi', action], 5000)
        } catch {
          await adbShell(device.serial, ['cmd', 'wifi', 'set-wifi-enabled', state ? 'enabled' : 'disabled'], 5000)
        }
      } else if (cleanSetting === 'data' || cleanSetting === 'mobile data') {
        await adbShell(device.serial, ['svc', 'data', action], 5000)
      } else if (cleanSetting === 'airplane' || cleanSetting === 'flight') {
        await adbShell(device.serial, ['cmd', 'connectivity', 'airplane-mode', action], 5000)
      } else if (cleanSetting === 'location' || cleanSetting === 'gps') {
        await adbShell(device.serial, ['settings', 'put', 'secure', 'location_mode', state ? '3' : '0'], 5000)
      } else if (cleanSetting === 'flashlight' || cleanSetting === 'torch') {
        await adbShell(device.serial, ['input', 'keyevent', 'KEYCODE_WAKEUP'], 5000)
        await adbShell(device.serial, ['cmd', 'statusbar', 'expand-settings'], 5000)
        pushPhoneEvent({ type: 'phone_action', action: 'hardware_toggle', setting: cleanSetting, state })
        return {
          success: true,
          warning:
            'Android blocks silent flashlight toggles on many devices. I opened Quick Settings instead.'
        }
      } else {
        return { success: false, error: `I do not know how to toggle ${setting}.` }
      }

      pushPhoneEvent({ type: 'phone_action', action: 'hardware_toggle', setting: cleanSetting, state })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: formatActionError(error) }
    }
  })
}
