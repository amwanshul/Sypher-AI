import { openFile } from '@renderer/functions/file-manager-api'

export const runIndexDirectory = async (folderPath: string) => {
  try {
    window.dispatchEvent(
      new CustomEvent('semantic-start', { detail: { mode: 'Index', target: folderPath } })
    )
    const result = await window.electron.ipcRenderer.invoke('index-folder', folderPath)
    window.dispatchEvent(
      new CustomEvent('semantic-done', { detail: { success: !result.includes('Error'), result } })
    )
    return result
  } catch (err) {
    window.dispatchEvent(new CustomEvent('semantic-done', { detail: { success: false } }))
    return `Error: ${err}`
  }
}

export const runSmartSearch = async (query: string) => {
  try {
    window.dispatchEvent(
      new CustomEvent('semantic-start', { detail: { mode: 'Search', target: query } })
    )

    const secureKeys = await window.electron.ipcRenderer.invoke('secure-get-keys').catch(() => null)
    const groqKey = secureKeys?.groqKey || localStorage.getItem('iris_groq_api_key') || ''

    const payload = await window.electron.ipcRenderer.invoke('smart-file-search', {
      query,
      groqKey,
      maxResults: 8
    })

    if (payload?.intent?.open_first && payload?.results?.[0]?.path) {
      await openFile(payload.results[0].path)
      payload.speechText = `Found and opened ${payload.results[0].name}.`
    }

    window.dispatchEvent(
      new CustomEvent('smart-file-results', {
        detail: {
          query,
          intent: payload?.intent,
          results: payload?.results || [],
          speechText: payload?.speechText,
          error: payload?.error
        }
      })
    )

    window.dispatchEvent(
      new CustomEvent('semantic-done', {
        detail: { success: Boolean(payload?.success), result: payload?.speechText || '' }
      })
    )

    if (Array.isArray(payload?.results) && payload.results.length > 0) {
      const resultLines = payload.results.slice(0, 5).map((file: any, index: number) =>
        [
          `${index + 1}. ${file.name}`,
          `Path: ${file.path}`,
          `Score: ${file.score}`,
          `Type: ${file.type}`,
          file.snippet ? `Snippet: ${file.snippet}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )

      const weakWarning =
        Number(payload.results[0]?.score) < 45
          ? '\nTop match is weak. Verify the file content before attaching or opening it.'
          : ''

      return [payload?.speechText || 'Smart file search finished.', weakWarning, ...resultLines]
        .filter(Boolean)
        .join('\n\n')
    }

    return payload?.speechText || 'Smart file search finished.'
  } catch (err) {
    window.dispatchEvent(new CustomEvent('semantic-done', { detail: { success: false } }))
    return `Error: ${err}`
  }
}
