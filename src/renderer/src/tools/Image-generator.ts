// Image generation tool — calls main process IPC to generate via Gemini API.
// Falls back to HuggingFace FLUX if Gemini key is unavailable.

export const handleImageGeneration = async (prompt: string) => {
  const loadingEvent = new CustomEvent('image-gen', {
    detail: { prompt: prompt, loading: true, url: '' }
  })
  window.dispatchEvent(loadingEvent)

  try {
    // Use main-process Gemini image generation (secure key access)
    const result: any = await window.electron.ipcRenderer.invoke('generate-image-gemini', prompt)

    if (!result.success) {
      throw new Error(result.error || 'Image generation failed.')
    }

    // result.filePath is the saved gallery image path
    // result.url is the file:// URL for display
    const successEvent = new CustomEvent('image-gen', {
      detail: {
        url: result.url,
        prompt: prompt,
        loading: false,
        error: false,
        savedPath: result.filePath
      }
    })
    window.dispatchEvent(successEvent)

    return `Image generated and saved to Gallery. File path: ${result.filePath}`
  } catch (e: any) {
    const errorEvent = new CustomEvent('image-gen', {
      detail: {
        url: '',
        prompt: prompt,
        loading: false,
        error: true,
        errorMessage: e.message
      }
    })
    window.dispatchEvent(errorEvent)

    return `Generation failed: ${e.message}`
  }
}
