import { ipcMain } from 'electron'
import Store from 'electron-store'
import bcrypt from 'bcryptjs'

const StoreClass = (Store as any).default || Store
const store = new StoreClass()

interface BiometricMeta {
  name: string
  enrolledAt: string
  facePreview?: string
}

type FaceSetupPayload = number[] | { descriptor: number[]; name?: string; facePreview?: string }

const isFaceDescriptor = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 128 && value.every((item) => typeof item === 'number')

const sanitizeBiometricName = (name: unknown, fallback: string) => {
  if (typeof name !== 'string') return fallback
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed.length > 0 ? trimmed.slice(0, 40) : fallback
}

const sanitizeFacePreview = (preview: unknown) =>
  typeof preview === 'string' &&
  preview.length <= 150000 &&
  /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(preview)
    ? preview
    : undefined

const normalizeMeta = (
  meta: Partial<BiometricMeta> | undefined,
  index: number,
  source?: Partial<BiometricMeta>
): BiometricMeta => {
  const fallbackName = `Identity ${index + 1}`
  const facePreview = sanitizeFacePreview(meta?.facePreview || source?.facePreview)

  return {
    name: sanitizeBiometricName(meta?.name || source?.name, fallbackName),
    enrolledAt:
      typeof meta?.enrolledAt === 'string'
        ? meta.enrolledAt
        : typeof source?.enrolledAt === 'string'
          ? source.enrolledAt
          : '',
    ...(facePreview ? { facePreview } : {})
  }
}

const getVaultFaces = (): { faces: number[][]; meta: BiometricMeta[] } => {
  const rawFaces = store.get('iris_vault_faces')
  const rawMeta = store.get('iris_vault_face_meta')
  const metaSource = Array.isArray(rawMeta) ? (rawMeta as Partial<BiometricMeta>[]) : []

  const faces: number[][] = []
  const meta: BiometricMeta[] = []

  if (Array.isArray(rawFaces)) {
    rawFaces.forEach((face, index) => {
      if (isFaceDescriptor(face)) {
        faces.push(face)
        meta.push(normalizeMeta(metaSource[index], index))
        return
      }

      if (face && typeof face === 'object' && isFaceDescriptor((face as any).descriptor)) {
        faces.push((face as any).descriptor)
        meta.push(
          normalizeMeta(metaSource[index], index, {
            name: (face as any).name,
            enrolledAt: (face as any).enrolledAt,
            facePreview: (face as any).facePreview
          })
        )
      }
    })
  }

  if (
    JSON.stringify(rawFaces || []) !== JSON.stringify(faces) ||
    JSON.stringify(rawMeta || []) !== JSON.stringify(meta)
  ) {
    store.set('iris_vault_faces', faces)
    store.set('iris_vault_face_meta', meta)
  }

  return { faces, meta }
}

export default function registerSecurityVault() {
  const legacyFace = store.get('iris_vault_face') as number[] | undefined
  if (isFaceDescriptor(legacyFace) && !store.get('iris_vault_faces')) {
    store.set('iris_vault_faces', [legacyFace])
    store.set('iris_vault_face_meta', [normalizeMeta(undefined, 0)])
    store.delete('iris_vault_face')
  }
  getVaultFaces()

  ipcMain.handle('check-vault-status', () => {
    const hasPin = !!store.get('iris_vault_hash')
    const { faces } = getVaultFaces()
    const hasFace = faces.length > 0
    return { hasPin, hasFace, faceCount: faces.length }
  })

  ipcMain.handle('get-vault-faces', () => {
    const { faces, meta } = getVaultFaces()
    return faces.map((_, index) => ({
      id: String(index),
      name: meta[index]?.name || `Identity ${index + 1}`,
      enrolledAt: meta[index]?.enrolledAt || '',
      facePreview: meta[index]?.facePreview
    }))
  })

  ipcMain.handle('remove-vault-face', (_, faceId: string) => {
    const index = Number.parseInt(faceId, 10)
    if (!Number.isInteger(index) || index < 0) return false

    const { faces, meta } = getVaultFaces()
    if (index >= faces.length) return false

    faces.splice(index, 1)
    meta.splice(index, 1)
    store.set('iris_vault_faces', faces)
    store.set('iris_vault_face_meta', meta)
    return true
  })

  ipcMain.handle('get-personality', () => {
    return store.get('iris_personality') as string | undefined
  })

  ipcMain.handle('set-personality', (_, text: string) => {
    store.set('iris_personality', text)
    return true
  })

  ipcMain.handle('setup-vault-pin', async (_, pin: string) => {
    const salt = await bcrypt.genSalt(10)
    const hash = await bcrypt.hash(pin, salt)
    store.set('iris_vault_hash', hash)
    return true
  })

  ipcMain.handle('verify-vault-pin', async (_, pin: string) => {
    const hash = store.get('iris_vault_hash') as string
    if (!hash) return false
    return await bcrypt.compare(pin, hash)
  })

  ipcMain.handle('setup-vault-face', (_, payload: FaceSetupPayload) => {
    const { faces, meta } = getVaultFaces()
    const descriptor = Array.isArray(payload) ? payload : payload?.descriptor
    if (!isFaceDescriptor(descriptor)) return false

    const facePreview = sanitizeFacePreview(
      Array.isArray(payload) ? undefined : payload?.facePreview
    )

    faces.push(descriptor)
    meta.push({
      name: sanitizeBiometricName(
        Array.isArray(payload) ? undefined : payload?.name,
        `Identity ${faces.length}`
      ),
      enrolledAt: new Date().toISOString(),
      ...(facePreview ? { facePreview } : {})
    })
    store.set('iris_vault_faces', faces)
    store.set('iris_vault_face_meta', meta)
    return true
  })

  ipcMain.handle('verify-vault-face', (_, descriptor: number[]) => {
    if (!isFaceDescriptor(descriptor)) return false

    const { faces } = getVaultFaces()
    if (faces.length === 0) return false

    for (const savedFace of faces) {
      if (savedFace.length !== 128) continue
      let distance = 0
      for (let i = 0; i < descriptor.length; i++) {
        distance += Math.pow(descriptor[i] - savedFace[i], 2)
      }
      distance = Math.sqrt(distance)

      if (distance < 0.55) return true
    }
    return false
  })
}
