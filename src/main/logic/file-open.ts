import { app, shell } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const IGNORE_FOLDERS = new Set([
  'node_modules',
  'appdata',
  'program files',
  'program files (x86)',
  'windows',
  'system volume information',
  '$recycle.bin',
  '.git'
])

const cleanFolderInput = (value: string) =>
  value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\b(folder|directory)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

const getSystemPath = (name: string) => {
  try {
    return app.getPath(name as any)
  } catch {
    const home = os.homedir()
    switch (name) {
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

const pathExistsAsDirectory = async (targetPath: string) => {
  try {
    return (await fs.stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

const getReadableDriveRoots = async () => {
  if (os.platform() !== 'win32') return ['/']

  const roots: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      await fs.access(drive)
      roots.push(drive)
    } catch {}
  }
  return roots
}

async function findFolderByName(folderName: string) {
  const targetName = folderName.toLowerCase()
  const roots = new Set<string>([
    os.homedir(),
    getSystemPath('desktop'),
    getSystemPath('documents'),
    getSystemPath('downloads'),
    path.join(os.homedir(), 'OneDrive')
  ])

  ;(await getReadableDriveRoots()).forEach((root) => roots.add(root))

  const queue = Array.from(roots)
    .filter(Boolean)
    .map((root) => ({ dir: root, depth: 0 }))
  const visited = new Set<string>()
  let inspected = 0

  while (queue.length > 0 && inspected < 2500) {
    const current = queue.shift()
    if (!current || visited.has(current.dir)) continue
    visited.add(current.dir)
    inspected += 1

    let entries
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lowerName = entry.name.toLowerCase()
      if (lowerName.startsWith('.') || lowerName.startsWith('$') || IGNORE_FOLDERS.has(lowerName)) {
        continue
      }

      const fullPath = path.join(current.dir, entry.name)
      if (lowerName === targetName) return fullPath
      if (current.depth < 2) queue.push({ dir: fullPath, depth: current.depth + 1 })
    }
  }

  return null
}

async function resolveFolderPath(inputPath: string) {
  const rawInput = cleanFolderInput(inputPath)
  const lowerInput = rawInput.toLowerCase()

  if (!rawInput) return null

  if (os.platform() === 'win32' && /^[a-zA-Z]:?$/.test(rawInput)) {
    const drivePath = `${rawInput.charAt(0).toUpperCase()}:\\`
    return (await pathExistsAsDirectory(drivePath)) ? drivePath : null
  }

  if (['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'].includes(lowerInput)) {
    return getSystemPath(lowerInput)
  }

  if (lowerInput === 'home' || rawInput === '~') return os.homedir()

  if (path.isAbsolute(rawInput)) {
    return (await pathExistsAsDirectory(rawInput)) ? rawInput : null
  }

  const candidatePaths = [
    path.join(os.homedir(), rawInput),
    path.join(getSystemPath('desktop'), rawInput),
    path.join(getSystemPath('documents'), rawInput),
    path.join(getSystemPath('downloads'), rawInput),
    path.join(os.homedir(), 'OneDrive', rawInput)
  ]

  for (const drive of await getReadableDriveRoots()) {
    candidatePaths.push(path.join(drive, rawInput))
  }

  for (const candidate of candidatePaths) {
    if (await pathExistsAsDirectory(candidate)) return candidate
  }

  return await findFolderByName(rawInput)
}

export default function registerFileOpen(ipcMain: Electron.IpcMain) {
  ipcMain.handle('file:open', async (_, filePath: string) => {
    try {

      const error = await shell.openPath(filePath)

      if (error) {
        return { success: false, error }
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: 'Internal System Error' }
    }
  })

  ipcMain.handle('file:reveal', async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: 'Failed to reveal item' }
    }
  })

  ipcMain.handle('folder:open', async (_, folderPath: string) => {
    try {
      const resolvedPath = await resolveFolderPath(folderPath)
      if (!resolvedPath) {
        return { success: false, error: `Folder not found: ${folderPath}` }
      }

      const error = await shell.openPath(resolvedPath)
      if (error) return { success: false, error }

      return { success: true, path: resolvedPath }
    } catch (e) {
      return { success: false, error: 'Internal System Error' }
    }
  })
}
