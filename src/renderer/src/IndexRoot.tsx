import { useState, useEffect, useRef } from 'react'
import MiniOverlay from './components/MiniOverlay'
import { sypherService } from './services/Sypher-voice-ai'
import { getScreenSourceId } from './hooks/CaptureDesktop'
import Sypher from './UI/Sypher'
import TerminalOverlay from './components/TerminalOverlay'
import LeafletMapWidget from './Widgets/MapView'
import ImageWidget from './Widgets/ImageWidget'
import EmailWidget from './Widgets/EmailWidget'
import WeatherWidget from './Widgets/WeatherWidget'
import StockWidget from './Widgets/StockWidget'
import LiveCodingWidget from './Widgets/LiveCodingWidget'
import WormholeWidget from './Widgets/WormholeWidget'
import OracleWidget from './Widgets/RagOrcaleWidget'
import ResearchWidget from './Widgets/DeepResearch'
import SemanticWidget from './Widgets/SematicSearch'
import SmartDropZonesWidget from './Widgets/SmartZoneWidget'
import SmartFileWidget from './Widgets/SmartFileWidget'
import TitleBar from './components/Titlebar'

export type VisionMode = 'camera' | 'screen' | 'none'

const IndexRoot = () => {
  const [isOverlay, setIsOverlay] = useState(false)

  const [isSystemActive, setIsSystemActive] = useState(false)
  const [isMicMuted, setIsMicMuted] = useState(true)

  const [isVideoOn, setIsVideoOn] = useState(false)
  const [visionMode, setVisionMode] = useState<VisionMode>('none')
  const [shortcutToast, setShortcutToast] = useState<{ id: number; message: string } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)

  const processingVideoRef = useRef<HTMLVideoElement>(document.createElement('video'))
  const activeStreamRef = useRef<MediaStream | null>(null)
  const aiIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const shortcutToastIdRef = useRef(0)

  useEffect(() => {
    window.electron.ipcRenderer.on('overlay-mode', (_e, mode) => setIsOverlay(mode))
    return () => {
      window.electron.ipcRenderer.removeAllListeners('overlay-mode')
    }
  }, [])

  useEffect(() => {
    const watchdog = setInterval(() => {
      if (isSystemActive && !sypherService.isConnected) {
        setIsSystemActive(false)
        setIsMicMuted(true)
        stopVision()
      }
    }, 1000)
    return () => clearInterval(watchdog)
  }, [isSystemActive])

  const toggleSystem = async () => {
    if (!isSystemActive) {
      try {
        await sypherService.connect()
        setIsSystemActive(true)
        setIsMicMuted(false)
        sypherService.setMute(false)
      } catch (err: any) {
        if (err.message === 'NO_API_KEY') {
          alert(
            '⚠️ CRITICAL ERROR: Gemini API Key is missing. Please enter it in the Command Center Vault (Settings Tab).'
          )
        } else {
          alert(`Connection failed: ${err.message}`)
        }
        setIsSystemActive(false)
      }
    } else {
      sypherService.disconnect()
      setIsSystemActive(false)
      setIsMicMuted(true)
      sypherService.setMute(true)
      stopVision()
    }
  }

  const toggleMic = () => {
    const s = !isMicMuted
    setIsMicMuted(s)
    sypherService.setMute(s)
  }

  const showShortcutStatus = (message: string) => {
    shortcutToastIdRef.current += 1
    setShortcutToast({ id: shortcutToastIdRef.current, message })
  }

  useEffect(() => {
    if (!shortcutToast) return

    const timer = window.setTimeout(() => setShortcutToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [shortcutToast?.id])

  const startVision = async (mode: 'camera' | 'screen') => {
    if (!isSystemActive) return

    try {
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach((t) => t.stop())
      }

      let stream: MediaStream

      if (mode === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 }
        })
      } else {
        const sourceId = await getScreenSourceId()
        if (!sourceId) return
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // @ts-ignore
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1280,
              maxHeight: 720
            }
          }
        })
      }

      activeStreamRef.current = stream

      processingVideoRef.current.srcObject = stream
      await processingVideoRef.current.play()

      setVisionMode(mode)
      setIsVideoOn(true)

      startAIProcessing()

      stream.getVideoTracks()[0].onended = () => stopVision()
    } catch (e) {
      stopVision()
    }
  }

  const stopVision = () => {
    setIsVideoOn(false)
    setVisionMode('none')

    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((t) => t.stop())
      activeStreamRef.current = null
    }

    if (processingVideoRef.current) {
      processingVideoRef.current.srcObject = null
    }

    if (aiIntervalRef.current) {
      clearInterval(aiIntervalRef.current)
      aiIntervalRef.current = null
    }
  }

  const startAIProcessing = () => {
    if (aiIntervalRef.current) clearInterval(aiIntervalRef.current)

    aiIntervalRef.current = setInterval(() => {
      const vid = processingVideoRef.current
      if (vid && vid.readyState === 4 && sypherService.socket?.readyState === WebSocket.OPEN) {
        const canvas = document.createElement('canvas')
        canvas.width = 800
        canvas.height = 450
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height)
          const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1]
          sypherService.sendVideoFrame(base64)
        }
      }
    }, 2000)
  }

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'sypher-shortcut',
      async (_event: any, payload: { action?: string; label?: string }) => {
        const action = payload?.action

        try {
          if (action === 'refresh-dashboard') {
            window.dispatchEvent(new CustomEvent('dashboard-refresh'))
            showShortcutStatus('Dashboard refreshed')
            return
          }

          if (action === 'clear-transcript-history') {
            await window.electron.ipcRenderer.invoke('clear-history')
            window.dispatchEvent(new CustomEvent('dashboard-refresh'))
            showShortcutStatus('Transcript history cleared')
            return
          }

          if (action === 'clear-phone-link-history') {
            await window.electron.ipcRenderer.invoke('adb-clear-history')
            window.dispatchEvent(new CustomEvent('phone-link-history-cleared'))
            showShortcutStatus('Phone link history cleared')
            return
          }

          if (action === 'toggle-mic') {
            toggleMic()
            showShortcutStatus(isMicMuted ? 'Voice mic on' : 'Voice mic off')
            return
          }

          if (action === 'toggle-agent') {
            await toggleSystem()
            showShortcutStatus(isSystemActive ? 'AI agent disconnected' : 'AI agent connecting')
            return
          }

          if (action === 'show-shortcuts') {
            setShowShortcuts((value) => !value)
          }
        } catch (error: any) {
          showShortcutStatus(error?.message || 'Shortcut failed')
        }
      }
    )

    return () => {
      if (typeof removeListener === 'function') removeListener()
    }
  }, [isMicMuted, isSystemActive])

  if (isOverlay) {
    return (
      <div className="w-screen h-screen overflow-hidden flex items-center justify-center bg-transparent">
        <MiniOverlay
          isSystemActive={isSystemActive}
          toggleSystem={toggleSystem}
          isMicMuted={isMicMuted}
          toggleMic={toggleMic}
          isVideoOn={isVideoOn}
          visionMode={visionMode}
          startVision={startVision}
          stopVision={stopVision}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-black overflow-hidden relative border border-emerald-500/20 rounded-xl">
      <TitleBar />
      <div className="flex-1 relative">
        <Sypher
          isSystemActive={isSystemActive}
          toggleSystem={toggleSystem}
          isMicMuted={isMicMuted}
          toggleMic={toggleMic}
          isVideoOn={isVideoOn}
          visionMode={visionMode}
          startVision={startVision}
          stopVision={stopVision}
          activeStream={activeStreamRef.current}
        />
      </div>
      <SmartDropZonesWidget />
      <SmartFileWidget />
      <SemanticWidget />
      <OracleWidget />
      <WormholeWidget />
      <LeafletMapWidget />
      <StockWidget />
      <WeatherWidget />
      <ImageWidget />
      <EmailWidget />
      <TerminalOverlay />
      <LiveCodingWidget />
      <ResearchWidget />
      {shortcutToast && (
        <div
          key={shortcutToast.id}
          role="status"
          className="shortcut-toast pointer-events-none absolute right-5 top-18 z-[10000] rounded-lg border border-emerald-500/30 bg-black/85 px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.12)]"
        >
          {shortcutToast.message}
        </div>
      )}
      {showShortcuts && (
        <div className="absolute inset-0 z-[10000] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-lg border border-emerald-500/30 bg-zinc-950 p-5 shadow-[0_0_60px_rgba(16,185,129,0.14)]">
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <h2 className="text-xs font-black uppercase tracking-[0.22em] text-zinc-100">
                Shortcut Controls
              </h2>
              <button
                onClick={() => setShowShortcuts(false)}
                className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-bold text-zinc-400 hover:border-red-500/40 hover:text-red-300"
              >
                CLOSE
              </button>
            </div>
            <div className="space-y-2 font-mono text-[11px]">
              {[
                ['Ctrl + R', 'Refresh dashboard data'],
                ['Ctrl + M', 'Turn voice mic on/off'],
                ['Ctrl + Shift + A', 'Connect/disconnect AI agent'],
                ['Ctrl + Shift + T', 'Clear transcript history'],
                ['Ctrl + Shift + P', 'Clear phone link history'],
                ['Ctrl + Shift + /', 'Show/hide this shortcut menu']
              ].map(([keys, label]) => (
                <div
                  key={keys}
                  className="flex items-center justify-between gap-4 rounded-md border border-white/5 bg-black/35 px-3 py-2"
                >
                  <span className="text-emerald-300">{keys}</span>
                  <span className="text-right text-zinc-400">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default IndexRoot
