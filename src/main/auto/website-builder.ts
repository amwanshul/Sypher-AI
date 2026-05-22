import { ipcMain, BrowserWindow, app, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { spawn } from 'child_process'
import { GoogleGenAI } from '@google/genai'

let previewWin: BrowserWindow | null = null
let lastGeneratedWebsitePath = ''

const getWebsitesDir = () => path.join(app.getPath('userData'), 'Websites')

const isGeneratedWebsitePath = (filePath: string) => {
  const websitesDir = path.resolve(getWebsitesDir())
  const targetPath = path.resolve(filePath)
  return targetPath === websitesDir || targetPath.startsWith(`${websitesDir}${path.sep}`)
}

const openPathInVSCode = (filePath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'code.cmd' : 'code'
    const child = spawn(command, [filePath], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    })

    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })

    setTimeout(() => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    }, 250)
  })

const getLatestGeneratedWebsitePath = async () => {
  if (lastGeneratedWebsitePath) return lastGeneratedWebsitePath

  try {
    const websitesDir = getWebsitesDir()
    const files = await fs.readdir(websitesDir)
    const htmlFiles = await Promise.all(
      files
        .filter((file) => file.toLowerCase().endsWith('.html'))
        .map(async (file) => {
          const filePath = path.join(websitesDir, file)
          const stats = await fs.stat(filePath)
          return { filePath, modifiedAt: stats.mtimeMs }
        })
    )

    const latest = htmlFiles.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]
    lastGeneratedWebsitePath = latest?.filePath || ''
  } catch (error) {
    lastGeneratedWebsitePath = ''
  }

  return lastGeneratedWebsitePath
}

export default function registerWebsiteBuilder() {
  ipcMain.removeHandler('website-get-latest')
  ipcMain.handle('website-get-latest', async () => {
    const filePath = await getLatestGeneratedWebsitePath()
    return filePath ? { success: true, filePath } : { success: false, error: 'No generated website found yet.' }
  })

  ipcMain.removeHandler('website-open-in-vscode')
  ipcMain.handle('website-open-in-vscode', async (_event, filePath?: string) => {
    try {
      const targetPath = filePath || (await getLatestGeneratedWebsitePath())
      if (!targetPath) return { success: false, error: 'No generated website found yet.' }
      if (!isGeneratedWebsitePath(targetPath)) return { success: false, error: 'Invalid generated website path.' }

      await openPathInVSCode(targetPath)
      return { success: true, filePath: targetPath }
    } catch (error) {
      return { success: false, error: `VS Code did not open. Make sure the "code" command is installed. ${String(error)}` }
    }
  })

  ipcMain.removeHandler('website-reveal-file')
  ipcMain.handle('website-reveal-file', async (_event, filePath?: string) => {
    const targetPath = filePath || (await getLatestGeneratedWebsitePath())
    if (!targetPath) return { success: false, error: 'No generated website found yet.' }
    if (!isGeneratedWebsitePath(targetPath)) return { success: false, error: 'Invalid generated website path.' }

    shell.showItemInFolder(targetPath)
    return { success: true, filePath: targetPath }
  })

  ipcMain.removeHandler('website-open-local')
  ipcMain.handle('website-open-local', async (_event, filePath?: string) => {
    const targetPath = filePath || (await getLatestGeneratedWebsitePath())
    if (!targetPath) return { success: false, error: 'No generated website found yet.' }
    if (!isGeneratedWebsitePath(targetPath)) return { success: false, error: 'Invalid generated website path.' }

    const error = await shell.openPath(targetPath)
    return error ? { success: false, error } : { success: true, filePath: targetPath }
  })

  ipcMain.removeHandler('website-read-html')
  ipcMain.handle('website-read-html', async (_event, filePath?: string) => {
    try {
      const targetPath = filePath || (await getLatestGeneratedWebsitePath())
      if (!targetPath) return { success: false, error: 'No generated website found yet.' }
      if (!isGeneratedWebsitePath(targetPath)) return { success: false, error: 'Invalid generated website path.' }

      const html = await fs.readFile(targetPath, 'utf-8')
      return { success: true, filePath: targetPath, html }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.removeHandler('website-save-copy')
  ipcMain.handle('website-save-copy', async (_event, filePath?: string) => {
    try {
      const targetPath = filePath || (await getLatestGeneratedWebsitePath())
      if (!targetPath) return { success: false, error: 'No generated website found yet.' }
      if (!isGeneratedWebsitePath(targetPath)) return { success: false, error: 'Invalid generated website path.' }

      const result = await dialog.showSaveDialog({
        title: 'Save Generated Website',
        defaultPath: path.join(app.getPath('documents'), path.basename(targetPath)),
        filters: [{ name: 'HTML Website', extensions: ['html'] }]
      })

      if (result.canceled || !result.filePath) return { success: false, error: 'Save cancelled.' }

      await fs.copyFile(targetPath, result.filePath)
      return { success: true, filePath: result.filePath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.removeHandler('build-animated-website')
  ipcMain.handle('build-animated-website', async (event, { prompt, geminiKey }) => {
    if (!event) return
    try {
      previewWin = new BrowserWindow({
        width: 1280,
        height: 720,
        title: 'SYPHER Live Forge :: Web Synthesis',
        backgroundColor: '#050505',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          nodeIntegration: false,
          contextIsolation: true
        }
      })

      const shellHtml = `<!DOCTYPE html>
<html>
<body style="margin:0; overflow:hidden; background:#050505; color:#d1fae5; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">
  <div style="position:fixed; top:0; left:0; right:0; height:52px; z-index:9998; display:flex; align-items:center; gap:12px; padding:0 14px; background:rgba(0,0,0,0.92); border-bottom:1px solid rgba(16,185,129,0.28); box-sizing:border-box;">
    <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
      <strong style="font-size:11px; letter-spacing:0.18em; color:#34d399;">SYPHER LIVE FORGE</strong>
      <span id="file-path" style="font-size:10px; color:#6ee7b7; opacity:0.72; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Generating website...</span>
    </div>
    <button data-action="vscode" disabled style="height:30px; padding:0 10px; border:1px solid rgba(16,185,129,0.35); border-radius:6px; background:rgba(16,185,129,0.1); color:#a7f3d0; font:700 10px monospace; letter-spacing:0.08em; cursor:pointer;">VS CODE</button>
    <button data-action="save" disabled style="height:30px; padding:0 10px; border:1px solid rgba(16,185,129,0.35); border-radius:6px; background:rgba(16,185,129,0.1); color:#a7f3d0; font:700 10px monospace; letter-spacing:0.08em; cursor:pointer;">SAVE COPY</button>
    <button data-action="folder" disabled style="height:30px; padding:0 10px; border:1px solid rgba(16,185,129,0.35); border-radius:6px; background:rgba(16,185,129,0.1); color:#a7f3d0; font:700 10px monospace; letter-spacing:0.08em; cursor:pointer;">FOLDER</button>
    <button data-action="refresh" disabled style="height:30px; padding:0 10px; border:1px solid rgba(16,185,129,0.35); border-radius:6px; background:rgba(16,185,129,0.1); color:#a7f3d0; font:700 10px monospace; letter-spacing:0.08em; cursor:pointer;">REFRESH</button>
    <button data-action="browser" disabled style="height:30px; padding:0 10px; border:1px solid rgba(16,185,129,0.35); border-radius:6px; background:rgba(16,185,129,0.1); color:#a7f3d0; font:700 10px monospace; letter-spacing:0.08em; cursor:pointer;">OPEN HTML</button>
  </div>
  <div id="status" style="position:fixed; top:62px; left:14px; right:14px; color:#86efac; font-size:11px; z-index:9999; pointer-events:none; text-shadow:0 0 5px #00ffaa;">
    [ SYPHER LIVE FORGE :: SYNTHESIZING UI... ]
  </div>
  <iframe id="live-frame" style="width:100vw; height:calc(100vh - 52px); margin-top:52px; border:none; background:#050505;"></iframe>
  <script>
    window.__sypherWebsiteFilePath = '';
    const statusEl = document.getElementById('status');
    const filePathEl = document.getElementById('file-path');
    const buttons = Array.from(document.querySelectorAll('button[data-action]'));

    const setStatus = (message, isError = false) => {
      statusEl.textContent = message;
      statusEl.style.color = isError ? '#fca5a5' : '#86efac';
      statusEl.style.display = 'block';
      if (!isError) setTimeout(() => { statusEl.style.display = 'none'; }, 3500);
    };

    const unlockActions = (filePath) => {
      window.__sypherWebsiteFilePath = filePath;
      filePathEl.textContent = filePath;
      buttons.forEach((button) => {
        button.disabled = false;
        button.style.opacity = '1';
      });
    };
    window.unlockActions = unlockActions;

    buttons.forEach((button) => {
      button.style.opacity = '0.45';
      button.addEventListener('click', async () => {
        const filePath = window.__sypherWebsiteFilePath;
        if (!filePath) return setStatus('[ WEBSITE IS STILL GENERATING ]', true);

        const action = button.getAttribute('data-action');
        const channel =
          action === 'vscode'
            ? 'website-open-in-vscode'
            : action === 'save'
              ? 'website-save-copy'
              : action === 'folder'
                ? 'website-reveal-file'
                : action === 'refresh'
                  ? 'website-read-html'
                  : 'website-open-local';

        try {
          const result = await window.electron.ipcRenderer.invoke(channel, filePath);
          if (result && result.success) {
            if (action === 'refresh') {
              document.getElementById('live-frame').srcdoc = result.html;
              setStatus('[ PREVIEW RELOADED FROM LOCAL HTML ]');
            } else {
              setStatus(action === 'save' ? '[ COPY SAVED LOCALLY ] ' + result.filePath : '[ ACTION COMPLETE ]');
            }
          } else {
            setStatus('[ ACTION FAILED ] ' + (result?.error || 'Unknown error'), true);
          }
        } catch (err) {
          setStatus('[ IPC ERROR ] ' + err.message, true);
        }
      });
    });
  </script>
</body>
</html>`

      // Write shell to a temp file so the preload script runs properly
      // (data: URLs don't always trigger preload in Electron)
      const shellDir = path.join(app.getPath('userData'), 'Websites')
      await fs.mkdir(shellDir, { recursive: true })
      const shellPath = path.join(shellDir, '_forge_shell.html')
      await fs.writeFile(shellPath, shellHtml, 'utf-8')
      await previewWin.loadFile(shellPath)

      if (!geminiKey || geminiKey.trim() === '') {
        throw new Error(
          'Missing Gemini API Key. Please configure it in the Command Center Vault (Settings Tab).'
        )
      }

      const ai = new GoogleGenAI({ apiKey: geminiKey })

      const sysPrompt = `You are an elite, Awwwards-winning frontend developer and UI/UX designer. 
Build a highly animated, visually stunning, clean, and premium website based on the user prompt.

CRITICAL RULES:
1. FORMAT: Use a SINGLE HTML file containing all HTML, CSS (in <style>), and JS (in <script>). Start strictly with <!DOCTYPE html>. DO NOT wrap in markdown blockquotes.
2. TECH STACK: 
   - Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
   - GSAP Core & ScrollTrigger: <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script> <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js"></script>
3. REAL IMAGERY ONLY (NO BROKEN LINKS):
   - NEVER invent or hallucinate Unsplash IDs or random URLs. They will break.
   - For ALL background and layout images, you MUST strictly use: "https://picsum.photos/1920/1080?random={number}" (Replace {number} with any digit from 1 to 50).
   - For Avatars, use: "https://i.pravatar.cc/150?img={number}" (Replace {number} with 1 to 50).
   - Use inline <svg> for icons.
4. EYE-CATCHING HERO ELEMENTS & MICRO-INTERACTIONS:
   - Hero Flair: The Hero section MUST include dynamic decorative elements to look premium. Add glowing background orbs (using Tailwind's blur-[100px] and opacity), a slowly rotating circular text stamp (e.g., 'EST 2024 • PREMIUM QUALITY •'), or small floating glassmorphism UI cards overlapping the main image.
   - Magnetic Buttons: Write vanilla JS with GSAP to make the main CTA buttons "magnetic" (the button moves slightly toward the cursor when hovering nearby).
   - Hover States: Add slick, sweeping gradients or scale-up effects (hover:scale-105 transition-transform) to all clickable elements and cards.
5. CONTENT DENSITY & LAYOUT:
   - Generate rich, realistic copy for all sections. NO empty spaces or generic "lorem ipsum" if possible.
   - Use beautiful CSS Grid / Bento-box layouts for Features/Services.
   - Rely heavily on stunning Typography (large fonts, contrasting weights).
6. EXACT THEMING & COLORS:
   - STOP defaulting to Tailwind's 'slate' or 'gray' classes. Use custom arbitrary hex values to match the vibe perfectly.
   - AI/Tech: Pitch black (bg-[#000000]), sleek glass, intense neon accents (text-[#39ff14] or cyan).
   - Cafe/Food: Warm earth tones, deep espresso browns (bg-[#1c140d]), creamy off-whites (text-[#f5ebd7]). NO SLATE GRAYS.
   - Corporate/SaaS: Absolute whites (bg-white), deep navy, trust-building blues.
7. SECTIONS (Must include 5-6 distinct sections):
   - Hero Section: High impact, full-screen. Large GSAP text reveals, the required eye-catching flair (orbs/stamps), and a working background image.
   - About/Mission: Heavy typography focus fading in on scroll.
   - Features/Services: Grid/Bento layout packed with details and hover glows.
   - Showcase/Gallery: Multiple working images in a masonry or horizontal scroll layout.
   - CTA & Footer: High energy, magnetic buttons, large text.

OUTPUT ONLY RAW HTML.`

      const response = await ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: `${sysPrompt}\n\nUSER PROMPT: ${prompt}`
      })

      let fullCode = ''

      for await (const chunk of response) {
        if (chunk.text) {
          fullCode += chunk.text

          let cleanCode = fullCode.replace(/^```html\n?/, '').replace(/```$/, '')

          const safeCode = encodeURIComponent(cleanCode)
          if (previewWin && !previewWin.isDestroyed()) {
            previewWin.webContents
              .executeJavaScript(
                `
              document.getElementById('live-frame').srcdoc = decodeURIComponent('${safeCode.replace(/'/g, "\\'")}');
            `
              )
              .catch(() => {})
          }
        }
      }

      if (previewWin && !previewWin.isDestroyed()) {
        previewWin.webContents
          .executeJavaScript(
            `
          document.getElementById('status').innerText = '[ SYNTHESIS COMPLETE :: SAVING HTML ]';
          document.getElementById('status').style.display = 'block';
        `
          )
          .catch(() => {})
      }

      const dirPath = getWebsitesDir()
      await fs.mkdir(dirPath, { recursive: true })

      const filePath = path.join(dirPath, `website_${Date.now()}.html`)
      const finalSaveCode = fullCode.replace(/^```html\n?/, '').replace(/```$/, '')
      await fs.writeFile(filePath, finalSaveCode.trim(), 'utf-8')
      lastGeneratedWebsitePath = filePath

      if (previewWin && !previewWin.isDestroyed()) {
        const safeFilePath = encodeURIComponent(filePath)
        previewWin.webContents
          .executeJavaScript(
            `
          window.unlockActions(decodeURIComponent('${safeFilePath}'));
          document.getElementById('status').innerText = '[ SAVED LOCALLY :: READY TO EDIT ]';
          document.getElementById('status').style.display = 'block';
        `
          )
          .catch(() => {})
      }

      return { success: true, filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
