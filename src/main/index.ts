import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  screen,
  session,
  safeStorage,
  systemPreferences,
  dialog
} from 'electron'
import path, { join } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import registerIpcHandlers from './logic/sypher-memory-save'
import registerSystemHandlers from './logic/get-system-info'
import registerFileSearch from './logic/file-search'
import registerFileOps from './logic/file-ops'
import registerFileWrite from './logic/file-write'
import registerFileRead from './logic/file-read'
import registerFileOpen from './logic/file-open'
import registerDirLoader from './logic/dir-load'
import registerFileScanner from './logic/file-launcher'
import registerAppLauncher from './logic/app-launcher'
import registerNotesHandlers from './logic/notes-manager'
import registerWebAgent from './logic/web-agent'
import registerGhostControl from './logic/ghost-control'
import registerterminalControl from './logic/terminal-control'
import registerGalleryHandlers from './logic/gallery-manager'
import registerGmailHandlers from './logic/gmail-manager'
import registerLocationHandlers from './logic/live-location'
import registerAdbHandlers from './logic/adb-manager'
import registerRealityHacker from './logic/reality-hacker'
import registerSypherCoder from './services/sypher-coder'
import registerTelekinesis from './logic/telekinesis'
import registerPermanentMemory from './logic/permanent-memory'
import registerWormhole from './services/wormhole'
import registerOracle from './services/RAG-oracle'
import registerDeepResearch from './services/deep-research'
import registerWidgetMaker from './auto/widget-manager'
import registerWebsiteBuilder from './auto/website-builder'
import registerWorkflowManager from './workflow/workflow-manager'
import registerDropZoneControl from './handlers/SmartDropZone-Handler'
import registerScreenPeeler from './handlers/ScreenPeeler-handler'
import registerPhantomKeyboard from './handlers/PhantomControl-handler'
import registerSecurityVault from './security/Security'
import registerLockSystem from './security/lock-system'
import registerEmailWatcherIpc from './ipc/email-watcher.ipc'
import registerGeminiImageGen from './logic/gemini-image-gen'
import { startEmailWatcher, stopEmailWatcher } from './services/EmailWatcherService'
import { autoUpdater } from 'electron-updater'

app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('sypher', process.execPath, [path.resolve(process.argv[1])])
    app.setAsDefaultProtocolClient('iris', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('sypher')
  app.setAsDefaultProtocolClient('iris')
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let isOverlayMode = false

const secureConfigPath = join(app.getPath('userData'), 'iris_secure_vault.json')

function installShortcutGuards(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const command = input.control || input.meta
    if (!command) return

    const sendShortcut = (action: string, label: string) => {
      event.preventDefault()
      window.webContents.send('sypher-shortcut', { action, label })
    }

    if (input.code === 'KeyR' && !input.shift && !input.alt) {
      sendShortcut('refresh-dashboard', 'Dashboard refreshed')
      return
    }

    if (input.code === 'KeyM' && !input.shift && !input.alt) {
      sendShortcut('toggle-mic', 'Voice mic toggled')
      return
    }

    if (input.code === 'KeyA' && input.shift && !input.alt) {
      sendShortcut('toggle-agent', 'AI agent toggled')
      return
    }

    if (input.code === 'KeyT' && input.shift && !input.alt) {
      sendShortcut('clear-transcript-history', 'Transcript history cleared')
      return
    }

    if (input.code === 'KeyP' && input.shift && !input.alt) {
      sendShortcut('clear-phone-link-history', 'Phone link history cleared')
      return
    }

    if (input.code === 'Slash' && input.shift && !input.alt) {
      sendShortcut('show-shortcuts', 'Shortcut menu')
      return
    }

    if (input.code === 'KeyL' && input.shift && !input.alt) {
      sendShortcut('lock-vault', 'Vault locked')
      return
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#050505',
    transparent: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) mainWindow.show()
  })

  ipcMain.on('window-min', () => mainWindow?.minimize())
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.on('window-max', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  installShortcutGuards(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', (event, commandLine) => {
  if (!event) {
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const url = commandLine.find((arg) => arg.startsWith('sypher://') || arg.startsWith('iris://'))
    if (url) {
      mainWindow.webContents.send('oauth-callback', url)
    }
  }
})

function toggleOverlayMode() {
  if (!mainWindow) return

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  if (isOverlayMode) {
    mainWindow.setResizable(true)
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setBounds({ width: 950, height: 670 })
    mainWindow.center()
    mainWindow.webContents.send('overlay-mode', false)
  } else {
    const w = 340
    const h = 70
    mainWindow.setBounds({
      width: w,
      height: h,
      x: Math.floor(width / 2 - w / 2),
      y: height - h - 50
    })
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.setResizable(false)
    mainWindow.webContents.send('overlay-mode', true)
  }
  isOverlayMode = !isOverlayMode
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.checkForUpdatesAndNotify()

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Found',
      message: `Neural Core Update Found: v${info.version}. Downloading in background...`
    })
  })

  autoUpdater.on('error', (err) => {
    dialog.showErrorBox(
      'Auto-Updater Error',
      err == null ? 'unknown error' : (err.stack || err).toString()
    )
  })

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: 'New version downloaded! The system will now force reboot to apply the patch.',
        buttons: ['Execute Restart']
      })
      .then(() => {
        setImmediate(() => {
          app.removeAllListeners('window-all-closed')
          autoUpdater.quitAndInstall(false, true)
        })
      })
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = [
      'media',
      'audioCapture',
      'videoCapture',
      'desktopVideoCapture',
      'microphone',
      'camera'
    ]
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowedPermissions = [
      'media',
      'audioCapture',
      'videoCapture',
      'desktopVideoCapture',
      'microphone',
      'camera'
    ]
    return allowedPermissions.includes(permission)
  })

  if (process.platform === 'darwin') {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone')
    }
    if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      systemPreferences.askForMediaAccess('camera')
    }
  }
  // ── Coordinate Picker ──
  ipcMain.handle('pick-screen-coordinate', async () => {
    return new Promise((resolve) => {
      if (mainWindow) mainWindow.minimize()

      // Short delay to let Sypher minimize
      setTimeout(() => {
        const { screen: electronScreen } = require('electron')
        const primaryDisplay = electronScreen.getPrimaryDisplay()
        const { width, height } = primaryDisplay.size

        const pickerWin = new BrowserWindow({
          width,
          height,
          x: 0,
          y: 0,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          fullscreen: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        })

        pickerWin.setIgnoreMouseEvents(false)

        const pickerHtml = `<!DOCTYPE html>
<html>
<head><style>
  * { margin:0; padding:0; }
  body {
    cursor: crosshair;
    background: rgba(0,0,0,0.15);
    width: 100vw; height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: ui-monospace, monospace;
    user-select: none;
    overflow: hidden;
  }
  .hint {
    position: fixed; top: 40px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.85); border: 1px solid rgba(16,185,129,0.5);
    padding: 10px 24px; border-radius: 8px;
    color: #34d399; font-size: 12px; letter-spacing: 0.15em;
    text-transform: uppercase; font-weight: 700;
    box-shadow: 0 0 30px rgba(16,185,129,0.15);
    pointer-events: none;
  }
  .coord {
    position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.85); border: 1px solid rgba(16,185,129,0.3);
    padding: 8px 20px; border-radius: 6px;
    color: #a7f3d0; font-size: 11px; letter-spacing: 0.1em;
    pointer-events: none;
  }
  .crosshair-v, .crosshair-h {
    position: fixed; background: rgba(16,185,129,0.35); pointer-events: none;
  }
  .crosshair-v { width: 1px; top: 0; bottom: 0; }
  .crosshair-h { height: 1px; left: 0; right: 0; }
</style></head>
<body>
  <div class="hint">CLICK ANYWHERE TO CAPTURE COORDINATES · ESC TO CANCEL</div>
  <div class="coord" id="coord">X: 0  Y: 0</div>
  <div class="crosshair-v" id="cv"></div>
  <div class="crosshair-h" id="ch"></div>
  <script>
    const cv = document.getElementById('cv');
    const ch = document.getElementById('ch');
    const coordEl = document.getElementById('coord');
    document.addEventListener('mousemove', (e) => {
      cv.style.left = e.clientX + 'px';
      ch.style.top = e.clientY + 'px';
      coordEl.textContent = 'X: ' + e.screenX + '  Y: ' + e.screenY;
    });
    document.addEventListener('click', (e) => {
      document.title = JSON.stringify({ x: e.screenX, y: e.screenY });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.title = 'CANCEL';
    });
  </script>
</body>
</html>`

        const pickerPath = require('path').join(app.getPath('userData'), '_coord_picker.html')
        require('fs').writeFileSync(pickerPath, pickerHtml)
        pickerWin.loadFile(pickerPath)

        pickerWin.webContents.on('page-title-updated', (_e, title) => {
          pickerWin.close()
          if (mainWindow) mainWindow.restore()

          if (title === 'CANCEL') {
            resolve({ cancelled: true })
          } else {
            try {
              const coords = JSON.parse(title)
              resolve({ cancelled: false, x: coords.x, y: coords.y })
            } catch {
              resolve({ cancelled: true })
            }
          }
        })

        pickerWin.on('closed', () => {
          if (mainWindow && mainWindow.isMinimized()) mainWindow.restore()
        })
      }, 400)
    })
  })

  ipcMain.handle('secure-save-keys', async (_, { groqKey, geminiKey, hfKey }) => {
    try {
      let groqEncrypted, geminiEncrypted, hfEncrypted

      if (safeStorage.isEncryptionAvailable()) {
        groqEncrypted = safeStorage.encryptString(groqKey || '').toString('base64')
        geminiEncrypted = safeStorage.encryptString(geminiKey || '').toString('base64')
        hfEncrypted = safeStorage.encryptString(hfKey || '').toString('base64')
      } else {
        groqEncrypted = Buffer.from(groqKey || '').toString('base64')
        geminiEncrypted = Buffer.from(geminiKey || '').toString('base64')
        hfEncrypted = Buffer.from(hfKey || '').toString('base64')
      }

      const secureData = {
        groq: groqEncrypted,
        gemini: geminiEncrypted,
        hf: hfEncrypted
      }

      fs.writeFileSync(secureConfigPath, JSON.stringify(secureData))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('secure-get-keys', async () => {
    if (!fs.existsSync(secureConfigPath)) return null
    try {
      const data = JSON.parse(fs.readFileSync(secureConfigPath, 'utf8'))
      let groqKey = '', geminiKey = '', hfKey = ''

      if (safeStorage.isEncryptionAvailable()) {
        if (data.groq) groqKey = safeStorage.decryptString(Buffer.from(data.groq, 'base64'))
        if (data.gemini) geminiKey = safeStorage.decryptString(Buffer.from(data.gemini, 'base64'))
        if (data.hf) hfKey = safeStorage.decryptString(Buffer.from(data.hf, 'base64'))
      } else {
        if (data.groq) groqKey = Buffer.from(data.groq, 'base64').toString('utf8')
        if (data.gemini) geminiKey = Buffer.from(data.gemini, 'base64').toString('utf8')
        if (data.hf) hfKey = Buffer.from(data.hf, 'base64').toString('utf8')
      }

      return { groqKey, geminiKey, hfKey }
    } catch (err) {
      return null
    }
  })

  ipcMain.handle('check-keys-exist', () => {
    return fs.existsSync(secureConfigPath)
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['content-security-policy']
    delete responseHeaders['x-content-security-policy']
    delete responseHeaders['access-control-allow-origin']

    callback({
      responseHeaders,
      statusLine: details.statusLine
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (mainWindow && (url.startsWith('sypher://') || url.startsWith('iris://'))) {
      mainWindow.webContents.send('oauth-callback', url)
    }
  })

  registerLockSystem()
  registerSecurityVault()
  registerEmailWatcherIpc()
  registerPhantomKeyboard()
  registerScreenPeeler()
  registerDropZoneControl(ipcMain)
  registerWorkflowManager()
  registerWebsiteBuilder()
  registerWidgetMaker()
  registerDeepResearch({ ipcMain })
  registerOracle({ ipcMain })
  registerWormhole({ ipcMain })
  registerPermanentMemory({ ipcMain, app })
  registerTelekinesis({ ipcMain })
registerSypherCoder({ ipcMain, app })
  registerRealityHacker(ipcMain)
  registerAdbHandlers(ipcMain)
  registerLocationHandlers(ipcMain)
  registerGmailHandlers(ipcMain)
  registerGalleryHandlers(ipcMain)
  registerGeminiImageGen(ipcMain)
  registerterminalControl(ipcMain)
  registerGhostControl(ipcMain)
  registerWebAgent(ipcMain)
  registerNotesHandlers(ipcMain)
  registerAppLauncher(ipcMain)
  registerDirLoader(ipcMain)
  registerFileOpen(ipcMain)
  registerFileSearch(ipcMain)
  registerFileRead(ipcMain)
  registerFileWrite(ipcMain)
  registerFileOps(ipcMain)
  registerFileScanner(ipcMain)
  registerSystemHandlers(ipcMain)
  registerIpcHandlers({ ipcMain, app })

  ipcMain.handle('get-screen-source', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    return sources[0]?.id
  })

  createWindow()

  // Start ambient email watcher after boot
  startEmailWatcher()

  globalShortcut.register('CommandOrControl+Shift+I', () => toggleOverlayMode())
  ipcMain.on('toggle-overlay', () => toggleOverlayMode())

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopEmailWatcher()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
