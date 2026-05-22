export const readEmails = async (maxResults: number = 5) => {
  try {
    const result: any = await window.electron.ipcRenderer.invoke('gmail-read', maxResults)

    const event = new CustomEvent('show-emails', {
      detail: { emails: result.uiData || [], error: result.error || null }
    })
    window.dispatchEvent(event)

    return result.speechText
  } catch (err) {
    window.dispatchEvent(
      new CustomEvent('show-emails', {
        detail: { emails: [], error: 'System Error: Could not read emails.' }
      })
    )
    return `System Error: Could not read emails.`
  }
}

const refreshEmailWidget = async (maxResults: number = 10) => {
  try {
    const result: any = await window.electron.ipcRenderer.invoke('gmail-read', maxResults)
    window.dispatchEvent(
      new CustomEvent('show-emails', {
        detail: { emails: result.uiData || [], error: result.error || null, refreshed: true }
      })
    )
  } catch {}
}

const gmailSucceeded = (result: unknown) =>
  typeof result === 'string' && !/^(send|draft|reply)\s+error:/i.test(result.trim())

export const sendEmail = async (to: string, subject: string, body: string, attachment_path?: string) => {
  try {
    const result = await window.electron.ipcRenderer.invoke('gmail-send', { to, subject, body, attachment_path })
    if (gmailSucceeded(result)) void refreshEmailWidget()
    return result
  } catch (err) {
    return `System Error: Could not send email.`
  }
}

export const draftEmail = async (to: string, subject: string, body: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('gmail-draft', { to, subject, body })
  } catch (err) {
    return `System Error: Could not draft email.`
  }
}

export const replyToEmail = async (email_id: string, body: string, attachment_path?: string) => {
  try {
    const result = await window.electron.ipcRenderer.invoke('gmail-reply', { email_id, body, attachment_path })
    if (gmailSucceeded(result)) void refreshEmailWidget()
    return result
  } catch (err) {
    return `System Error: Could not send reply.`
  }
}
