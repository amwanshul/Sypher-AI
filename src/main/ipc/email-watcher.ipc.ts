// IPC handlers for the Ambient Email Watcher — start/stop/status control from renderer.

import { ipcMain } from 'electron'
import {
  startEmailWatcher,
  stopEmailWatcher,
  getEmailWatcherStatus
} from '../services/EmailWatcherService'

export default function registerEmailWatcherIpc(): void {
  ipcMain.removeHandler('email-watcher:start')
  ipcMain.handle('email-watcher:start', async () => {
    try {
      startEmailWatcher()
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.removeHandler('email-watcher:stop')
  ipcMain.handle('email-watcher:stop', async () => {
    try {
      stopEmailWatcher()
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.removeHandler('email-watcher:status')
  ipcMain.handle('email-watcher:status', async () => {
    return getEmailWatcherStatus()
  })
}
