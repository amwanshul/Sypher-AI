let lastGeneratedWebsitePath = ''

export const buildAnimatedWebsite = async (prompt: string) => {
  try {
    // Retrieve key from secure vault
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    const geminiKey = keys?.geminiKey || ''

    if (!geminiKey.trim()) {
      return 'System Error: Missing Gemini API Key. Please update it in the Command Center Vault.'
    }

    const res = await window.electron.ipcRenderer.invoke('build-animated-website', {
      prompt,
      geminiKey
    })

    if (res.success) {
      lastGeneratedWebsitePath = res.filePath
      return `Website generated successfully and saved locally to ${res.filePath}. Use the Live Forge toolbar to open it in VS Code, save a copy, reveal the folder, or open the HTML file.`
    }

    return `System Error during synthesis: ${res.error}`
  } catch (error) {
    return 'System Error: Unable to establish connection to the Live Forge.'
  }
}

export const openLastGeneratedWebsiteInVsCode = async () => {
  try {
    let filePath = lastGeneratedWebsitePath

    if (!filePath) {
      const latest = await window.electron.ipcRenderer.invoke('website-get-latest')
      if (latest?.success) filePath = latest.filePath
    }

    if (!filePath) {
      return {
        success: false,
        message: 'No generated website is available yet. Generate a web UI first.'
      }
    }

    const result = await window.electron.ipcRenderer.invoke('website-open-in-vscode', filePath)
    if (!result?.success) {
      return {
        success: false,
        message: result?.error || 'Failed to open the generated website in VS Code.'
      }
    }

    lastGeneratedWebsitePath = result.filePath || filePath
    return {
      success: true,
      message: `Opened generated website in VS Code: ${lastGeneratedWebsitePath}`
    }
  } catch (error) {
    return {
      success: false,
      message: 'System Error: Unable to open the generated website in VS Code.'
    }
  }
}
