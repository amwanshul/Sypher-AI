import { IpcMain, app } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import Groq from 'groq-sdk'

let pipeline: any = null
let lancedb: any = null

const getSystemPath = (name: string) => {
  try {
    return app.getPath(name as any)
  } catch (e) {
    const home = os.homedir()
    switch (name.toLowerCase()) {
      case 'desktop':
        return path.join(home, 'Desktop')
      case 'documents':
        return path.join(home, 'Documents')
      case 'downloads':
        return path.join(home, 'Downloads')
      case 'music':
        return path.join(home, 'Music')
      case 'pictures':
        return path.join(home, 'Pictures')
      case 'videos':
        return path.join(home, 'Videos')
      default:
        return home
    }
  }
}

async function getActiveDrives(): Promise<string[]> {
  if (os.platform() === 'win32') {
    const drives: string[] = []
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\'
      try {
        await fs.promises.access(drive, fs.constants.R_OK)
        drives.push(drive)
      } catch {
        continue
      }
    }
    return drives.length > 0 ? drives : ['C:\\']
  }
  return ['/']
}

const IGNORE_FOLDERS = new Set([
  'node_modules',
  'appdata',
  'program files',
  'windows',
  'system volume information',
  'dist',
  'build',
  '.git',
  '$recycle.bin'
])

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.cs',
  '.go',
  '.rs',
  '.sql',
  '.xml',
  '.yaml',
  '.yml'
])

const PDF_EXTENSIONS = new Set(['.pdf'])
const WORD_EXTENSIONS = new Set(['.docx'])
const OFFICE_XML_EXTENSIONS = new Set(['.xlsx', '.pptx'])
const SMART_SEARCH_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...WORD_EXTENSIONS,
  ...OFFICE_XML_EXTENSIONS,
  '.doc',
  '.xls',
  '.ppt',
  '.ipynb',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp3',
  '.mp4',
  '.zip'
])

const FILE_TYPE_ALIASES: Record<string, string[]> = {
  doc: ['.pdf', '.docx', '.doc', '.txt', '.md'],
  docs: ['.pdf', '.docx', '.doc', '.txt', '.md'],
  document: ['.pdf', '.docx', '.doc', '.txt', '.md'],
  documents: ['.pdf', '.docx', '.doc', '.txt', '.md'],
  assignment: ['.pdf', '.docx', '.doc', '.txt', '.md'],
  report: ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.md'],
  pdf: ['.pdf'],
  word: ['.docx', '.doc'],
  excel: ['.xlsx', '.xls', '.csv'],
  spreadsheet: ['.xlsx', '.xls', '.csv'],
  sheet: ['.xlsx', '.xls', '.csv'],
  code: ['.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.rs'],
  python: ['.py', '.ipynb'],
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  photo: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4'],
  audio: ['.mp3'],
  presentation: ['.pptx', '.ppt'],
  slides: ['.pptx', '.ppt']
}

type SmartFileIntent = {
  query: string
  file_types: string[] | null
  days_ago: number | null
  root_target?: string | null
  open_first?: boolean
}

type SmartFileResult = {
  path: string
  name: string
  score: number
  modified: string
  modifiedTs: number
  size_kb: number
  type: string
  snippet: string
  source: 'filename' | 'content' | 'mixed'
}

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[_\-.,()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const unique = <T,>(items: T[]) => Array.from(new Set(items))

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function levenshtein(a: string, b: string) {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]
  }

  return previous[b.length]
}

function fuzzyRatio(query: string, target: string) {
  const q = normalizeSearchText(query)
  const t = normalizeSearchText(target)
  if (!q || !t) return 0
  if (t.includes(q)) return 100

  const qTokens = q.split(' ').filter(Boolean)
  const tTokens = new Set(t.split(' ').filter(Boolean))
  const tokenHits = qTokens.filter((token) => tTokens.has(token) || t.includes(token)).length
  const tokenScore = qTokens.length ? (tokenHits / qTokens.length) * 70 : 0
  const distance = levenshtein(q, t)
  const editScore = (1 - distance / Math.max(q.length, t.length)) * 100

  return clamp(Math.max(tokenScore, editScore), 0, 100)
}

function inferDaysAgo(text: string): number | null {
  const normalized = text.toLowerCase()
  if (/\byesterday\b/.test(normalized)) return 1
  if (/\btoday\b/.test(normalized)) return 1
  if (/\blast\s+week\b|\bthis\s+week\b/.test(normalized)) return 7
  if (/\blast\s+month\b|\bthis\s+month\b/.test(normalized)) return 30

  const daysMatch = normalized.match(/\b(?:last|past|previous)\s+(\d+)\s+days?\b/)
  if (daysMatch) return Number(daysMatch[1])

  const weekMatch = normalized.match(/\b(?:last|past|previous)\s+(\d+)\s+weeks?\b/)
  if (weekMatch) return Number(weekMatch[1]) * 7

  return null
}

function inferRootTarget(text: string): string | null {
  const normalized = text.toLowerCase()
  for (const root of ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']) {
    if (normalized.includes(root)) return root
  }
  if (normalized.includes('onedrive') || normalized.includes('one drive')) return 'onedrive'
  return null
}

function inferFileTypes(text: string): string[] | null {
  const normalized = text.toLowerCase()
  const explicitExtensions = Array.from(
    normalized.matchAll(/\b(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|py|ipynb|js|ts|tsx|jsx|png|jpe?g|webp|mp3|mp4|zip)\b/g),
    (match) => match[1].replace('jpeg', 'jpg')
  )

  if (explicitExtensions.length > 0) return unique(explicitExtensions)

  for (const [alias, extensions] of Object.entries(FILE_TYPE_ALIASES)) {
    if (normalized.includes(alias)) return unique(extensions.map((ext) => ext.replace('.', '')))
  }

  return null
}

function inferQuery(text: string) {
  let query = text
    .replace(/\b(find|search for|where is|where's|locate|look for|show me|open|the|my|file|files|from|in|on|latest|recent)\b/gi, ' ')
    .replace(/\b(last|past|previous|this)\s+(week|month|\d+\s+days?|\d+\s+weeks?)\b/gi, ' ')
    .replace(/\b(yesterday|today|desktop|documents|downloads|onedrive|one drive|folder)\b/gi, ' ')
    .replace(/\b(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|py|ipynb|js|ts|tsx|jsx|png|jpe?g|webp|mp3|mp4|zip|document|documents|docs|file|files)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!query) query = text.replace(/\s+/g, ' ').trim()
  return query
}

async function parseSmartFileIntent(command: string, groqKey?: string): Promise<SmartFileIntent> {
  const fallback: SmartFileIntent = {
    query: inferQuery(command),
    file_types: inferFileTypes(command),
    days_ago: inferDaysAgo(command),
    root_target: inferRootTarget(command),
    open_first: /\b(open|launch|show me)\b/i.test(command)
  }

  if (!groqKey?.trim()) return fallback

  try {
    const groq = new Groq({ apiKey: groqKey })
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'Extract smart file search intent from the user command. Return only valid JSON.',
            'Fields: query string, file_types array of extensions without dot or null, days_ago integer or null, root_target desktop/documents/downloads/onedrive/music/pictures/videos or null, open_first boolean.',
            'Map "last week" to 7, "yesterday" to 1, "last month" to 30.',
            'For assignments/reports/documents, use file_types ["pdf","docx","doc","txt","md"] unless a specific extension is spoken.'
          ].join('\n')
        },
        { role: 'user', content: command }
      ]
    })

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}')
    return {
      query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : fallback.query,
      file_types: Array.isArray(parsed.file_types) ? parsed.file_types.map(String) : fallback.file_types,
      days_ago:
        Number.isFinite(Number(parsed.days_ago)) && Number(parsed.days_ago) > 0
          ? Number(parsed.days_ago)
          : fallback.days_ago,
      root_target:
        typeof parsed.root_target === 'string' && parsed.root_target.trim()
          ? parsed.root_target.trim()
          : fallback.root_target,
      open_first: typeof parsed.open_first === 'boolean' ? parsed.open_first : fallback.open_first
    }
  } catch {
    return fallback
  }
}

function resolveFileTypeFilter(fileTypes?: string[] | null) {
  if (!fileTypes?.length) return SMART_SEARCH_EXTENSIONS

  const extensions = new Set<string>()
  for (const rawType of fileTypes) {
    const normalized = String(rawType).toLowerCase().trim().replace(/^\./, '')
    if (!normalized) continue

    const mapped = FILE_TYPE_ALIASES[normalized]
    if (mapped) {
      mapped.forEach((ext) => extensions.add(ext))
    } else {
      extensions.add(`.${normalized}`)
    }
  }

  return extensions.size > 0 ? extensions : SMART_SEARCH_EXTENSIONS
}

async function resolveSmartSearchRoots(rootTarget?: string | null) {
  const home = os.homedir()
  const normalized = String(rootTarget || '').toLowerCase().trim()
  const roots = new Set<string>()

  if (normalized) {
    if (normalized === 'onedrive') roots.add(path.join(home, 'OneDrive'))
    else if (['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'].includes(normalized)) {
      roots.add(getSystemPath(normalized))
    } else if (path.isAbsolute(rootTarget || '')) {
      roots.add(rootTarget!)
    }
  }

  if (roots.size === 0) {
    ;['desktop', 'documents', 'downloads', 'onedrive'].forEach((root) => {
      roots.add(root === 'onedrive' ? path.join(home, 'OneDrive') : getSystemPath(root))
    })
  }

  return Array.from(roots).filter((root) => fs.existsSync(root))
}

async function extractSmartFileText(filePath: string, maxChars = 2500) {
  const ext = path.extname(filePath).toLowerCase()
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > 8 * 1024 * 1024) return ''

    if (TEXT_EXTENSIONS.has(ext)) {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return content.replace(/\s+/g, ' ').slice(0, maxChars)
    }

    if (WORD_EXTENSIONS.has(ext)) {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      return String(result.value || '').replace(/\s+/g, ' ').slice(0, maxChars)
    }

    if (PDF_EXTENSIONS.has(ext)) {
      const { PDFParse } = await import('pdf-parse')
      const data = await fs.promises.readFile(filePath)
      const parser = new PDFParse({ data })
      try {
        const result = await parser.getText({ partial: [1, 2, 3] })
        return String(result.text || '').replace(/\s+/g, ' ').slice(0, maxChars)
      } finally {
        await parser.destroy()
      }
    }

    if (OFFICE_XML_EXTENSIONS.has(ext)) {
      return await extractOfficeXmlText(filePath, ext, maxChars)
    }
  } catch {}

  return ''
}

function stripOfficeXml(xml: string) {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function extractOfficeXmlText(filePath: string, ext: string, maxChars: number) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath))
  const fileNames = Object.keys(zip.files)
    .filter((fileName) => {
      if (zip.files[fileName].dir) return false
      if (ext === '.xlsx') {
        return (
          fileName === 'xl/sharedStrings.xml' ||
          /^xl\/worksheets\/sheet\d+\.xml$/i.test(fileName)
        )
      }
      return /^ppt\/slides\/slide\d+\.xml$/i.test(fileName)
    })
    .slice(0, 8)

  const chunks: string[] = []
  for (const fileName of fileNames) {
    const xml = await zip.files[fileName].async('string')
    chunks.push(stripOfficeXml(xml))
    if (chunks.join(' ').length >= maxChars) break
  }

  return chunks.join(' ').slice(0, maxChars)
}

function buildSnippet(content: string, query: string) {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (!compact) return ''

  const normalized = compact.toLowerCase()
  const token = normalizeSearchText(query).split(' ').find((part) => part.length > 2)
  const index = token ? normalized.indexOf(token) : -1
  const start = index > 40 ? index - 40 : 0
  const snippet = compact.slice(start, start + 180)
  const lastSpace = snippet.lastIndexOf(' ')
  const safeSnippet = snippet.length === 180 && lastSpace > 120 ? snippet.slice(0, lastSpace) : snippet
  return safeSnippet.trim() + (start + safeSnippet.length < compact.length ? '...' : '')
}

function scoreSmartFile(filePath: string, query: string, content: string, stat: fs.Stats) {
  const fileName = path.basename(filePath, path.extname(filePath))
  const nameScore = fuzzyRatio(query, fileName)
  const contentScore = content ? fuzzyRatio(query, content) : 0
  const daysOld = (Date.now() - stat.mtimeMs) / 86400000
  const recencyScore = Math.max(0, (30 - daysOld) / 30) * 20
  const score = nameScore * 0.6 + contentScore * 0.3 + recencyScore

  return {
    score,
    source: contentScore > nameScore + 8 ? 'content' : nameScore > contentScore + 8 ? 'filename' : 'mixed'
  }
}

async function smartSearchFiles(intent: SmartFileIntent, maxResults = 8) {
  const roots = await resolveSmartSearchRoots(intent.root_target)
  const allowedExtensions = resolveFileTypeFilter(intent.file_types)
  const since = intent.days_ago ? Date.now() - intent.days_ago * 86400000 : 0
  const query = intent.query.trim()
  const results: SmartFileResult[] = []
  const queue = [...roots]
  const visited = new Set<string>()
  let inspectedFiles = 0

  while (queue.length > 0 && inspectedFiles < 4500) {
    const currentDir = queue.shift()
    if (!currentDir || visited.has(currentDir)) continue
    visited.add(currentDir)

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      const nameLower = entry.name.toLowerCase()

      if (entry.isDirectory()) {
        if (nameLower.startsWith('.') || nameLower.startsWith('$') || IGNORE_FOLDERS.has(nameLower)) continue
        queue.push(fullPath)
        continue
      }

      if (!entry.isFile()) continue

      const ext = path.extname(nameLower)
      if (!allowedExtensions.has(ext)) continue

      inspectedFiles += 1

      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(fullPath)
      } catch {
        continue
      }

      if (since && stat.mtimeMs < since) continue

      const nameScore = fuzzyRatio(query, path.basename(fullPath, ext))
      const shouldReadContent =
        TEXT_EXTENSIONS.has(ext) ||
        WORD_EXTENSIONS.has(ext) ||
        OFFICE_XML_EXTENSIONS.has(ext) ||
        (PDF_EXTENSIONS.has(ext) && (nameScore > 10 || Boolean(intent.days_ago) || Boolean(intent.file_types?.length)))
      const content = shouldReadContent ? await extractSmartFileText(fullPath) : ''
      const { score, source } = scoreSmartFile(fullPath, query, content, stat)

      if (score < 35) continue

      results.push({
        path: fullPath,
        name: path.basename(fullPath),
        score: Math.round(score * 10) / 10,
        modified: new Date(stat.mtimeMs).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }),
        modifiedTs: stat.mtimeMs,
        size_kb: Math.round((stat.size / 1024) * 10) / 10,
        type: ext.replace('.', ''),
        snippet: buildSnippet(content, query),
        source: source as SmartFileResult['source']
      })
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.modifiedTs - a.modifiedTs)
    .slice(0, maxResults)
}

export default function registerFileSearch(ipcMain: IpcMain) {
  ipcMain.handle('smart-file-search', async (event, { query, groqKey, maxResults = 8 }) => {
    try {
      const intent = await parseSmartFileIntent(String(query || ''), groqKey)

      event.sender.send('smart-file-progress', {
        status: 'searching',
        text: `Searching for ${intent.query || query}`,
        progress: 35
      })

      const results = await smartSearchFiles(intent, Math.max(1, Math.min(Number(maxResults) || 8, 20)))
      const top = results[0]

      event.sender.send('smart-file-progress', {
        status: 'done',
        text: results.length ? `Found ${results.length} matches.` : 'No matches found.',
        progress: 100
      })

      if (!top) {
        return {
          success: false,
          intent,
          results,
          speechText: `No files found matching "${intent.query}".`
        }
      }

      return {
        success: true,
        intent,
        results,
        speechText: `Found ${results.length} file${results.length === 1 ? '' : 's'}. Best match: ${top.name}, modified ${top.modified}.`
      }
    } catch (error: any) {
      return {
        success: false,
        intent: { query: String(query || ''), file_types: null, days_ago: null },
        results: [],
        speechText: `Smart file search failed: ${error?.message || String(error)}`,
        error: error?.message || String(error)
      }
    }
  })

  ipcMain.handle('index-folder', async (event, folderPath: string) => {
    try {
      event.sender.send('semantic-progress', {
        status: 'booting',
        text: 'Initializing Neural Engine...',
        progress: 10
      })
      if (!pipeline) pipeline = (await import('@xenova/transformers')).pipeline
      if (!lancedb) lancedb = await import('vectordb')

      const dbPath = path.join(app.getPath('userData'), 'iris_semantic_db')
      const db = await lancedb.connect(dbPath)

      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

      event.sender.send('semantic-progress', {
        status: 'scanning',
        text: `Native Sweeping folder...`,
        progress: 50
      })

      const filesToIndex: string[] = []
      const VALID_INDEX_EXTENSIONS = new Set([
        '.txt',
        '.md',
        '.js',
        '.ts',
        '.tsx',
        '.jsx',
        '.json',
        '.py',
        '.html',
        '.css'
      ])

      async function scanForIndexing(dir: string) {
        let entries
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch (err) {
          return
        }

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const nameLower = entry.name.toLowerCase()

          if (entry.isDirectory()) {
            if (
              nameLower.startsWith('.') ||
              nameLower.startsWith('$') ||
              IGNORE_FOLDERS.has(nameLower)
            )
              continue
            await scanForIndexing(fullPath)
          } else if (entry.isFile()) {
            if (VALID_INDEX_EXTENSIONS.has(path.extname(nameLower))) filesToIndex.push(fullPath)
          }
        }
      }

      await scanForIndexing(path.resolve(folderPath))

      const records: any[] = []
      let processed = 0

      for (const file of filesToIndex) {
        try {
          const content = await fs.promises.readFile(file, 'utf-8')
          if (content.trim().length === 0) continue

          processed++
          if (processed % 5 === 0)
            event.sender.send('semantic-progress', {
              status: 'indexing',
              text: `Vectorizing: ${path.basename(file)}`,
              progress: 50 + (processed / filesToIndex.length) * 40
            })

          const textChunk = content.substring(0, 1000)
          const output = await extractor(textChunk, { pooling: 'mean', normalize: true })
          records.push({
            vector: Array.from(output.data),
            file_path: file,
            file_name: path.basename(file),
            content_snippet: textChunk.substring(0, 200)
          })
        } catch (e) {}
      }

      event.sender.send('semantic-progress', {
        status: 'saving',
        text: 'Writing DB...',
        progress: 95
      })
      if (records.length > 0) {
        try {
          const table = await db.openTable('files')
          await table.add(records)
        } catch {
          await db.createTable('files', records)
        }
      }
      return `✅ Successfully indexed ${filesToIndex.length} files.`
    } catch (err) {
      return `❌ Indexing Error: ${String(err)}`
    }
  })

  ipcMain.handle('search-files', async (event, { query, groqKey }) => {
    try {
      event.sender.send('semantic-progress', {
        status: 'searching',
        text: 'Waking Llama 3.1...',
        progress: 10
      })

      if (!groqKey || groqKey.trim() === '') {
        throw new Error('Missing Groq API Key. Please configure it in the Command Center Vault.')
      }

      let semanticResultsText = ''
      let nativeResultsText = ''
      let searchParams = { keywords: [] as string[], root_target: '' }

      const runSemantic = async () => {
        try {
          if (!pipeline) pipeline = (await import('@xenova/transformers')).pipeline
          if (!lancedb) lancedb = await import('vectordb')
          const dbPath = path.join(app.getPath('userData'), 'iris_semantic_db')
          if (!fs.existsSync(dbPath)) return

          const db = await lancedb.connect(dbPath)
          const table = await db.openTable('files')
          const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
          const queryOutput = await extractor(query, { pooling: 'mean', normalize: true })
          const results = await table.search(Array.from(queryOutput.data)).limit(3).execute()

          if (results.length > 0) {
            semanticResultsText =
              `🧠 CONTENT MEMORY MATCHES:\n` +
              results.map((r: any) => `- ${r.file_path}`).join('\n') +
              '\n\n'
          }
        } catch (e) {}
      }

      const runNativeCrawler = async () => {
        const groq = new Groq({ apiKey: groqKey })

        const prompt = `
          Extract the core search keywords from this user query: "${query}".
          RULES:
          1. Extract the specific file name (e.g. "mainresume"), extension ("pdf", "txt"), and nested folder names ("career").
          2. NEVER include the words "file", "document", "folder", or "find" in the keywords array. Use exact extensions only (e.g., "pdf" not "pdf file").
          3. FIX ANY SPELLING MISTAKES (e.g., "carrer" -> "career").
          4. If the user mentions a root location (like "desktop", "documents", "downloads"), put it in the "root_target" string. Otherwise leave it empty.
          5. Output JSON with "keywords" (array of lowercase strings) and "root_target" (string).
        `

        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          model: 'llama-3.1-8b-instant',
          response_format: { type: 'json_object' }
        })

        try {
          const parsed = JSON.parse(
            chatCompletion.choices[0]?.message?.content || '{"keywords":[]}'
          )
          searchParams.root_target = parsed.root_target || ''
          if (Array.isArray(parsed.keywords)) searchParams.keywords = parsed.keywords
          else if (typeof parsed.keywords === 'string')
            searchParams.keywords = parsed.keywords.split(/[\s,]+/)
        } catch (e) {
          searchParams.keywords = []
        }

        searchParams.keywords = searchParams.keywords
          .filter(Boolean)
          .map((kw) => String(kw).toLowerCase().trim())
        if (searchParams.keywords.length === 0) return

        event.sender.send('semantic-progress', {
          status: 'searching',
          text: `Engine Locked On: [ ${searchParams.keywords.join(' + ')} ]`,
          progress: 30
        })

        const searchRoots = new Set<string>()
        let rawInput = searchParams.root_target.trim().toLowerCase()

        if (rawInput) {
          if (os.platform() === 'win32' && (rawInput.length === 1 || rawInput.includes('drive'))) {
            const driveLetter = rawInput.charAt(0).toUpperCase()
            searchRoots.add(`${driveLetter}:\\`)
          } else if (
            ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'].includes(rawInput)
          ) {
            searchRoots.add(getSystemPath(rawInput))
          } else {
            searchRoots.add(path.join(os.homedir(), rawInput))
          }
        } else {
          searchRoots.add(os.homedir())
          const drives = await getActiveDrives()
          drives.forEach((d) => {
            if (!d.startsWith('C')) searchRoots.add(d)
          })
        }

        const rootArray = Array.from(searchRoots)
        event.sender.send('semantic-progress', {
          status: 'searching',
          text: `Native Sweeping Nested Folders...`,
          progress: 50
        })

        const foundFiles: string[] = []
        const queue: string[] = [...rootArray]
        const visited = new Set<string>()

        while (queue.length > 0 && foundFiles.length < 15) {
          const currentDir = queue.shift()

          if (!currentDir || visited.has(currentDir)) continue
          visited.add(currentDir)

          let entries
          try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
          } catch (err) {
            continue
          }

          for (const entry of entries) {
            if (foundFiles.length >= 15) break

            const fullPath = path.join(currentDir, entry.name)
            const lowerPath = fullPath.toLowerCase()

            let isDir = entry.isDirectory()
            let isFile = entry.isFile()

            if (entry.isSymbolicLink()) {
              try {
                const stat = await fs.promises.stat(fullPath)
                isDir = stat.isDirectory()
                isFile = stat.isFile()
              } catch (e) {
                continue
              }
            }

            if (isDir) {
              const name = entry.name.toLowerCase()
              if (name.startsWith('.') || name.startsWith('$') || IGNORE_FOLDERS.has(name)) continue

              queue.push(fullPath)
            } else if (isFile) {
              const isMatch = searchParams.keywords.every((kw: string) => lowerPath.includes(kw))
              if (isMatch) {
                foundFiles.push(fullPath)
              }
            }
          }
        }

        const uniqueResults = Array.from(new Set(foundFiles))
        if (uniqueResults.length > 0) {
          nativeResultsText =
            `⚡ NATIVE DEEP SYSTEM MATCHES:\n` + uniqueResults.slice(0, 15).join('\n')
        }
      }

      await Promise.all([runSemantic(), runNativeCrawler()])

      event.sender.send('semantic-progress', {
        status: 'searching',
        text: 'Consolidating Results...',
        progress: 95
      })

      const finalOutput = (semanticResultsText + nativeResultsText).trim()

      if (finalOutput.length > 0) {
        return finalOutput
      } else {
        return `No files found matching [ ${searchParams.keywords.join(', ')} ]`
      }
    } catch (err) {
      return `❌ System Error: ${String(err)}`
    }
  })
}
