import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RiCloseLine,
  RiSave3Line,
  RiSearchLine,
  RiCheckLine,
  RiTerminalBoxLine,
  RiChromeLine,
  RiCodeLine,
  RiSpotifyLine,
  RiDiscordLine,
  RiGamepadLine,
  RiFocus3Line,
  RiKeyboardLine
} from 'react-icons/ri'
import { getAllApps, AppItem } from '@renderer/services/system-info'

const SmartIcon = ({ name, size = 16 }: { name: string; size?: number }) => {
  if (!name) return <div className={`w-8 h-8 bg-zinc-800 rounded-md border border-white/5`} />

  const lower = name.toLowerCase()
  let icon = <RiTerminalBoxLine size={size} />
  let color = 'text-zinc-400'
  let bg = 'bg-zinc-800'

  if (lower.includes('chrome') || lower.includes('edge') || lower.includes('brave')) {
    icon = <RiChromeLine size={size} />
    color = 'text-blue-400'
    bg = 'bg-blue-500/10'
  } else if (lower.includes('code') || lower.includes('dev')) {
    icon = <RiCodeLine size={size} />
    color = 'text-cyan-400'
    bg = 'bg-cyan-500/10'
  } else if (lower.includes('spotify') || lower.includes('music')) {
    icon = <RiSpotifyLine size={size} />
    color = 'text-green-400'
    bg = 'bg-green-500/10'
  } else if (
    lower.includes('discord') ||
    lower.includes('telegram') ||
    lower.includes('whatsapp')
  ) {
    icon = <RiDiscordLine size={size} />
    color = 'text-indigo-400'
    bg = 'bg-indigo-500/10'
  } else if (lower.includes('game') || lower.includes('launcher') || lower.includes('epic')) {
    icon = <RiGamepadLine size={size} />
    color = 'text-purple-400'
    bg = 'bg-purple-500/10'
  }

  return (
    <div
      className={`w-8 h-8 rounded-md flex items-center justify-center border border-white/5 ${bg} ${color} shadow-sm shrink-0`}
    >
      {icon}
    </div>
  )
}

const AppSelector = ({ value, onChange }: { value: string; onChange: (val: string) => void }) => {
  const [allApps, setAllApps] = useState<AppItem[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedTerm, setDebouncedTerm] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAllApps().then((raw) => {
      const cleanData = (Array.isArray(raw) ? raw : []).filter(
        (item) => item && typeof item === 'object' && item.name
      )
      setAllApps(cleanData)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTerm(searchTerm)
      setPage(1) 
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm])

  const filteredApps = allApps.filter((app) =>
    app.name.toLowerCase().includes(debouncedTerm.toLowerCase())
  )

  const sortedApps = [...filteredApps].sort((a, b) => {
    if (a.name === value) return -1
    if (b.name === value) return 1
    return 0
  })

  const visibleApps = sortedApps.slice(0, page * 15)

  const observer = useRef<IntersectionObserver | null>(null)
  const lastElementRef = useCallback(
    (node: HTMLDivElement) => {
      if (loading) return
      if (observer.current) observer.current.disconnect()

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && visibleApps.length < sortedApps.length) {
          setPage((prev) => prev + 1)
        }
      })
      if (node) observer.current.observe(node)
    },
    [loading, visibleApps.length, sortedApps.length]
  )

  return (
    <div className="flex flex-col gap-2 relative w-full">
      <div className="relative w-full">
        <RiSearchLine
          className="absolute left-3 top-1/2 transform -translate-y-1/2 text-zinc-500"
          size={14}
        />
        <input
          type="text"
          placeholder="Search installed apps..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-[#09090b] border border-[#27272a] rounded-md text-xs py-2 pl-9 pr-3 text-white outline-none focus:border-emerald-500 transition-colors placeholder-zinc-700"
        />
      </div>

      <div className="flex flex-col gap-1.5 h-120 overflow-y-auto scrollbar-small bg-[#09090b] border border-[#27272a] rounded-md p-1.5 w-full shadow-inner">
        {loading && <p className="text-[10px] text-zinc-500 p-2 text-center">Indexing System...</p>}
        {!loading && visibleApps.length === 0 && (
          <p className="text-[10px] text-zinc-500 p-2 text-center">No apps found.</p>
        )}

        {visibleApps.map((app, index) => {
          const isSelected = value === app.name
          const isLast = visibleApps.length === index + 1

          const AppRow = (
            <div
              onClick={() => onChange(app.name)}
              className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all duration-300 transform active:scale-95 group ${isSelected ? 'bg-emerald-500/15 border border-emerald-500/60 shadow-[0_0_15px_rgba(16,185,129,0.15)] order-first' : 'hover:bg-[#18181b] border border-transparent hover:border-white/5'}`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div
                  className={`transition-transform duration-300 ${isSelected ? 'scale-110' : 'group-hover:scale-105'}`}
                >
                  <SmartIcon name={app.name} />
                </div>
                <span
                  className={`text-xs font-bold truncate ${isSelected ? 'text-emerald-400' : 'text-zinc-300'}`}
                >
                  {app.name}
                </span>
              </div>
              {isSelected && (
                <RiCheckLine
                  className="text-emerald-500 shrink-0 mx-2 animate-in zoom-in-50 duration-200"
                  size={18}
                />
              )}
            </div>
          )

          if (isLast)
            return (
              <div ref={lastElementRef} key={`${app.id}-${index}`}>
                {AppRow}
              </div>
            )
          return <div key={`${app.id}-${index}`}>{AppRow}</div>
        })}
      </div>
    </div>
  )
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

const ShortcutRecorder = ({
  currentKey,
  currentModifiers,
  onCapture
}: {
  currentKey: string
  currentModifiers: string
  onCapture: (key: string, modifiers: string) => void
}) => {
  const [isRecording, setIsRecording] = useState(false)
  const inputRef = useRef<HTMLDivElement>(null)

  const formatDisplay = () => {
    if (!currentKey && !currentModifiers) return ''
    const mods = currentModifiers
      ? currentModifiers.split(',').map((m) => m.trim()).filter(Boolean)
      : []
    const parts = [...mods.map((m) => m.charAt(0).toUpperCase() + m.slice(1)), currentKey.toUpperCase()]
    return parts.join(' + ')
  }

  useEffect(() => {
    if (!isRecording) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (MODIFIER_KEYS.has(e.key)) return

      const modifiers: string[] = []
      if (e.ctrlKey) modifiers.push('control')
      if (e.shiftKey) modifiers.push('shift')
      if (e.altKey) modifiers.push('alt')
      if (e.metaKey) modifiers.push('meta')

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

      onCapture(key, modifiers.join(', '))
      setIsRecording(false)
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [isRecording, onCapture])

  const display = formatDisplay()

  return (
    <div className="flex flex-col gap-2 w-full">
      <label className="text-[10px] text-zinc-400 uppercase tracking-widest">
        Shortcut
      </label>
      <div
        ref={inputRef}
        tabIndex={0}
        onClick={() => setIsRecording(true)}
        onBlur={() => setTimeout(() => setIsRecording(false), 200)}
        className={`flex items-center gap-2 bg-[#09090b] border rounded-md p-3 cursor-pointer transition-all min-h-[44px] ${
          isRecording
            ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
            : 'border-[#27272a] hover:border-zinc-600'
        }`}
      >
        <RiKeyboardLine size={14} className={isRecording ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'} />
        {isRecording ? (
          <span className="text-xs text-emerald-400 font-mono tracking-wider animate-pulse">
            Press your shortcut...
          </span>
        ) : display ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            {display.split(' + ').map((part, i) => (
              <span
                key={i}
                className="bg-zinc-800 border border-zinc-700 text-zinc-200 px-2 py-0.5 rounded text-[10px] font-mono tracking-wider uppercase"
              >
                {part}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-zinc-600 font-mono">Click to record shortcut</span>
        )}
      </div>
      {display && (
        <button
          onClick={() => {
            onCapture('', '')
          }}
          className="text-[9px] text-zinc-600 hover:text-red-400 transition-colors self-end uppercase tracking-widest cursor-pointer"
        >
          Clear
        </button>
      )}
    </div>
  )
}

export default function ParameterEditorDrawer({ nodeData, updateNodeInputs, closeEditor }: any) {
  const tool = nodeData?.data?.tool
  const [localInputs, setLocalInputs] = useState<any>({})
  const [localComment, setLocalComment] = useState('')

  useEffect(() => {
    if (nodeData) {
      setLocalInputs(nodeData.data.inputs || {})
      setLocalComment(nodeData.data.comment || '')
    }
  }, [nodeData])

  if (!nodeData || !tool) return null

  const handleInputChange = (key: string, value: string) => {
    setLocalInputs((prev: any) => ({ ...prev, [key]: value }))
  }

  const [isPicking, setIsPicking] = useState(false)

  const pickCoordinate = async () => {
    setIsPicking(true)
    try {
      const result = await (window as any).electron.ipcRenderer.invoke('pick-screen-coordinate')
      if (!result.cancelled) {
        setLocalInputs((prev: any) => ({
          ...prev,
          x: String(result.x),
          y: String(result.y)
        }))
      }
    } catch (e) {
      console.error('Coordinate picker failed:', e)
    }
    setIsPicking(false)
  }

  const handleSave = () => {
    updateNodeInputs(nodeData.id, localInputs, localComment)
    closeEditor()
  }

  return (
    <div className="absolute top-0 right-0 w-80 h-full bg-[#111113] border-l border-[#27272a] shadow-2xl flex flex-col z-50 animate-in slide-in-from-right-8 duration-200">
      <div className="p-4 border-b border-[#27272a] flex justify-between items-center bg-[#18181b]">
        <span className="text-xs font-bold tracking-widest text-emerald-400 uppercase">
          Configure Module
        </span>
        <button
          onClick={closeEditor}
          className="text-zinc-500 hover:text-red-400 transition-colors cursor-pointer bg-black/40 p-1.5 rounded-md"
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      <div className="p-5 grow overflow-y-auto flex flex-col gap-6 custom-scrollbar scrollbar-small">
        <div>
          <h3 className="text-sm font-black text-white uppercase tracking-widest mb-1 flex items-center gap-2">
            {tool.name.replace(/_/g, ' ')}
          </h3>
          <p className="text-[10px] text-zinc-500 leading-relaxed font-mono">{tool.description}</p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[10px] text-zinc-400 uppercase tracking-widest font-bold">
            Node Comment
          </label>
          <input
            type="text"
            placeholder="e.g., 'Boot up Dev Server'"
            className="bg-[#09090b] border border-[#27272a] rounded-md text-xs p-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder-zinc-700 shadow-inner"
            value={localComment}
            onChange={(e) => setLocalComment(e.target.value)}
          />
        </div>

        <div className="h-px w-full bg-[#27272a]" />

        <div className="flex flex-col gap-4">
          <h4 className="text-[10px] font-bold tracking-widest text-emerald-500 uppercase">
            Parameters
          </h4>

          {tool.parameters?.properties && Object.keys(tool.parameters.properties).length > 0 ? (
            tool.name === 'press_shortcut' ? (
              <ShortcutRecorder
                currentKey={localInputs['key'] || ''}
                currentModifiers={localInputs['modifiers'] || ''}
                onCapture={(key, modifiers) => {
                  setLocalInputs((prev: any) => ({
                    ...prev,
                    key,
                    modifiers
                  }))
                }}
              />
            ) : (
            Object.entries(tool.parameters.properties).map(([key, prop]: any) => (
              <div key={key} className="flex flex-col gap-2 w-full">
                <label className="text-[10px] text-zinc-400 uppercase tracking-widest">
                  {key.replace(/_/g, ' ')}
                </label>

                {key === 'app_name' && (tool.name === 'open_app' || tool.name === 'close_app') ? (
                  <AppSelector
                    value={localInputs[key] || ''}
                    onChange={(val) => handleInputChange(key, val)}
                  />
                ) : prop.enum ? (
                  <select
                    className="bg-[#09090b] border border-[#27272a] rounded-md text-xs p-2.5 text-white outline-none focus:border-emerald-500 transition-colors cursor-pointer w-full"
                    value={localInputs[key] || ''}
                    onChange={(e) => handleInputChange(key, e.target.value)}
                  >
                    <option value="">Select option...</option>
                    {prop.enum.map((opt: string) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex items-center gap-2 w-full">
                    <input
                      type={prop.type === 'NUMBER' ? 'number' : 'text'}
                      placeholder={prop.description || ''}
                      className="bg-[#09090b] border border-[#27272a] rounded-md text-xs p-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder-zinc-700 font-mono shadow-inner flex-1"
                      value={localInputs[key] || ''}
                      onChange={(e) => handleInputChange(key, e.target.value)}
                    />
                    {tool.name === 'click_on_screen' && key === 'x' && (
                      <button
                        onClick={pickCoordinate}
                        disabled={isPicking}
                        className={`p-2.5 rounded-md border transition-all cursor-pointer shrink-0 ${
                          isPicking
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 animate-pulse'
                            : 'bg-[#09090b] border-[#27272a] text-zinc-500 hover:text-emerald-400 hover:border-emerald-500/50'
                        }`}
                        title="Pick coordinates from screen"
                      >
                        <RiFocus3Line size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
            )
          ) : (
            <p className="text-[10px] text-zinc-600 italic uppercase tracking-widest bg-black/30 p-2 rounded text-center border border-white/5">
              No configuration needed.
            </p>
          )}
        </div>
      </div>

      <div className="p-4 border-t border-[#27272a] bg-[#18181b]">
        <button
          onClick={handleSave}
          className="w-full bg-emerald-600 hover:bg-emerald-500 text-black py-2.5 rounded-lg text-[11px] font-black tracking-widest transition-all shadow-[0_0_15px_rgba(16,185,129,0.2)] flex items-center justify-center gap-2 cursor-pointer"
        >
          <RiSave3Line size={16} /> APPLY CHANGES
        </button>
      </div>
    </div>
  )
}
