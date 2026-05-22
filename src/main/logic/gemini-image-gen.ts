import { IpcMain, app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { HfInference } from '@huggingface/inference'

const VAULT_PATH = () => path.join(app.getPath('userData'), 'iris_secure_vault.json')
const GALLERY_DIR = () => path.resolve(app.getPath('userData'), 'Gallery')

function getHuggingFaceKey(): string | null {
  try {
    const vaultPath = VAULT_PATH()
    if (!fs.existsSync(vaultPath)) return process.env.HF_TOKEN || null

    const data = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'))
    if (data.hf) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(data.hf, 'base64'))
        }
      } catch {
        // Fall through
      }
      const decoded = Buffer.from(data.hf, 'base64').toString('utf8')
      if (decoded.trim()) return decoded
    }
    return process.env.HF_TOKEN || null
  } catch {
    return process.env.HF_TOKEN || null
  }
}

export default function registerGeminiImageGen(ipcMain: IpcMain) {
  ipcMain.removeHandler('generate-image-gemini')
  ipcMain.handle('generate-image-gemini', async (_event, prompt: string) => {
    try {
      const hfKey = getHuggingFaceKey()
      if (!hfKey) {
        throw new Error(
          'HuggingFace API key not found. Please add it in Settings → API Keys → Hugging Face Vision, then save.'
        )
      }

      console.log('[Image Gen] Generating with FLUX.1-schnell...')
      const hf = new HfInference(hfKey)
      const blob = await hf.textToImage({
        model: 'black-forest-labs/FLUX.1-schnell',
        inputs: prompt,
        parameters: {
          width: 1024,
          height: 1024
        }
      })

      const arrayBuffer = await blob.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      // Save to Gallery
      const galleryDir = GALLERY_DIR()
      if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true })

      const safeTitle = (prompt || 'visual')
        .replace(/[^a-z0-9]/gi, '_')
        .toLowerCase()
        .substring(0, 50)

      const fileName = `${safeTitle}_${Date.now()}_Generated_by_SYPHER.png`
      const filePath = path.join(galleryDir, fileName)

      fs.writeFileSync(filePath, buffer)
      const fileUrl = pathToFileURL(filePath).href

      console.log('[Image Gen] FLUX success:', filePath)
      return { success: true, filePath, url: fileUrl }
    } catch (e: any) {
      console.error('[Image Gen] Failed:', e.message || e)
      return { success: false, error: e.message || 'Image generation failed.' }
    }
  })
}
