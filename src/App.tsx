import {
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  LoaderCircle,
  Mic,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Upload,
  Wand2,
} from 'lucide-react'
import type { ChangeEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  decodeBlobToAudioSource,
  decodeFileToAudioSource,
  type AudioSource,
} from './lib/audio'
import { cleanupArticulation } from './lib/articulation'
import { createMidiBlob } from './lib/midi'
import { adjustNotes, defaultSettings, inferKey } from './lib/music'
import { playPianoNotes, type PlaybackHandle } from './lib/playback'
import { KEYS, SCALES } from './lib/types'
import type {
  AdjustedNote,
  AnalysisSettings,
  ManualNoteEdit,
  RawTranscription,
} from './lib/types'

const GRID_OPTIONS = [
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
  { value: 0.125, label: '1/32' },
]

type AppStatus = 'idle' | 'ready' | 'recording' | 'analyzing' | 'complete'

const initialSettings = defaultSettings({
  key: 'C',
  scale: 'major',
  confidence: 0,
})

function App() {
  const [source, setSource] = useState<AudioSource | null>(null)
  const [rawTranscription, setRawTranscription] =
    useState<RawTranscription | null>(null)
  const [settings, setSettings] = useState<AnalysisSettings>(initialSettings)
  const [manualEdits, setManualEdits] = useState<
    Record<string, ManualNoteEdit>
  >({})
  const [status, setStatus] = useState<AppStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [isPlayingMidi, setIsPlayingMidi] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const playbackRef = useRef<PlaybackHandle | null>(null)

  const suggestedKey = useMemo(
    () =>
      inferKey(
        rawTranscription
          ? cleanupArticulation(
              rawTranscription.notes,
              settings.articulationCleanup,
            ).notes
          : [],
      ),
    [rawTranscription, settings.articulationCleanup],
  )
  const cleanedMelody = useMemo(
    () =>
      rawTranscription
        ? cleanupArticulation(
            rawTranscription.notes,
            settings.articulationCleanup,
          )
        : { notes: [], mergedCount: 0, originalCount: 0 },
    [rawTranscription, settings.articulationCleanup],
  )
  const adjustedNotes = useMemo(
    () =>
      rawTranscription
        ? adjustNotes(cleanedMelody.notes, settings, manualEdits)
        : [],
    [cleanedMelody.notes, manualEdits, rawTranscription, settings],
  )

  useEffect(() => {
    return () => {
      playbackRef.current?.stop()
    }
  }, [])

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    await loadSource(() => decodeFileToAudioSource(file))
    event.target.value = ''
  }

  async function startRecording() {
    try {
      setError('')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      )
      chunksRef.current = []
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        })
        void loadSource(() => decodeBlobToAudioSource(blob, 'Mic recording'))
      }

      recorder.start()
      setStatus('recording')
    } catch (recordingError) {
      setStatus(source ? 'ready' : 'idle')
      setError(errorMessage(recordingError))
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
  }

  async function analyzeSource() {
    if (!source) {
      return
    }

    try {
      stopMidiPlayback()
      setError('')
      setStatus('analyzing')
      setProgress(0)
      const { transcribeWithBasicPitch } = await import('./lib/transcription')
      const raw = await transcribeWithBasicPitch(source.buffer, setProgress)
      const cleaned = cleanupArticulation(
        raw.notes,
        initialSettings.articulationCleanup,
      )
      const suggestion = inferKey(cleaned.notes)
      setRawTranscription(raw)
      setManualEdits({})
      setSettings((current) => ({
        ...defaultSettings(suggestion),
        exportPitchBends: current.exportPitchBends,
      }))
      setStatus('complete')
    } catch (analysisError) {
      setStatus('ready')
      setError(errorMessage(analysisError))
    }
  }

  function exportMidi() {
    if (adjustedNotes.length === 0) {
      return
    }

    const blob = createMidiBlob(adjustedNotes, settings)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'hummed-melody.mid'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function toggleMidiPlayback() {
    if (isPlayingMidi) {
      stopMidiPlayback()
      return
    }

    if (adjustedNotes.length === 0) {
      return
    }

    try {
      setError('')
      setIsPlayingMidi(true)
      playbackRef.current = await playPianoNotes(adjustedNotes, () => {
        playbackRef.current = null
        setIsPlayingMidi(false)
      })
    } catch (playbackError) {
      setIsPlayingMidi(false)
      setError(errorMessage(playbackError))
    }
  }

  function stopMidiPlayback() {
    playbackRef.current?.stop()
    playbackRef.current = null
    setIsPlayingMidi(false)
  }

  function updateSetting<K extends keyof AnalysisSettings>(
    key: K,
    value: AnalysisSettings[K],
  ) {
    if (key === 'articulationCleanup') {
      stopMidiPlayback()
      setManualEdits({})
    }

    setSettings((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function nudgeNote(noteId: string, semitones: number) {
    const note = adjustedNotes.find((candidate) => candidate.id === noteId)
    if (!note) {
      return
    }

    stopMidiPlayback()
    setManualEdits((current) => ({
      ...current,
      [noteId]: {
        ...current[noteId],
        midi: note.midi + semitones,
      },
    }))
  }

  function resetNote(noteId: string) {
    stopMidiPlayback()
    setManualEdits((current) => {
      const next = { ...current }
      delete next[noteId]
      return next
    })
  }

  async function loadSource(loader: () => Promise<AudioSource>) {
    try {
      setError('')
      const nextSource = await loader()
      if (source?.url) {
        URL.revokeObjectURL(source.url)
      }
      setSource(nextSource)
      setRawTranscription(null)
      setManualEdits({})
      stopMidiPlayback()
      setProgress(0)
      setStatus('ready')
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Music Copilot / Vocal melody</p>
          <h1>Humming to notes</h1>
          <p className="hero-copy">
            Best with a clear hum, la, or du on one melody line in a quiet
            room.
          </p>
        </div>
        <div className="status-pill">
          <span className={`status-dot status-${status}`} />
          {statusLabel(status)}
        </div>
      </header>

      <section className="transport" aria-label="Transport controls">
        <button
          className="primary-action"
          type="button"
          onClick={status === 'recording' ? stopRecording : startRecording}
          disabled={status === 'analyzing'}
          title={status === 'recording' ? 'Stop recording' : 'Record humming'}
        >
          {status === 'recording' ? <Square size={18} /> : <Mic size={18} />}
          {status === 'recording' ? 'Stop' : 'Record'}
        </button>

        <label className="icon-button file-button" title="Upload audio file">
          <Upload size={18} />
          <span>Upload</span>
          <input
            type="file"
            accept="audio/*"
            onChange={handleUpload}
            disabled={status === 'recording' || status === 'analyzing'}
          />
        </label>

        <button
          className="icon-button"
          type="button"
          onClick={analyzeSource}
          disabled={!source || status === 'recording' || status === 'analyzing'}
          title="Analyze audio"
        >
          {status === 'analyzing' ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Wand2 size={18} />
          )}
          Analyze
        </button>

        <button
          className="icon-button"
          type="button"
          onClick={exportMidi}
          disabled={adjustedNotes.length === 0}
          title="Export MIDI"
        >
          <Download size={18} />
          Export MIDI
        </button>

        <button
          className="icon-button"
          type="button"
          onClick={toggleMidiPlayback}
          disabled={adjustedNotes.length === 0}
          title={isPlayingMidi ? 'Stop MIDI playback' : 'Play MIDI as piano'}
        >
          {isPlayingMidi ? <Square size={18} /> : <Play size={18} />}
          {isPlayingMidi ? 'Stop MIDI' : 'Play MIDI'}
        </button>

        <div className="source-strip">
          <FileAudio size={18} />
          <div>
            <strong>{source?.name ?? 'No audio loaded'}</strong>
            <span>
              {source ? formatSeconds(source.duration) : 'Record or upload'}
            </span>
          </div>
        </div>
      </section>

      <section className="guidance-strip" aria-label="Recording guidance">
        <span>Vocal melody mode</span>
        <span>Hum, la, or du clearly</span>
        <span>Use one melody line</span>
        <span>Keep background noise low</span>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      {status === 'analyzing' ? (
        <div className="progress-track" aria-label="Analysis progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}

      <section className="workspace">
        <section className="timeline-panel" aria-label="Melody timeline">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Timeline</p>
              <h2>Raw pitch and corrected melody</h2>
            </div>
            <div className="legend">
              <span>
                <i className="legend-raw" /> Raw
              </span>
              <span>
                <i className="legend-adjusted" /> Corrected
              </span>
            </div>
          </div>

          {cleanedMelody.mergedCount > 0 ? (
            <div className="cleanup-indicator" role="status">
              <strong>Articulation cleanup applied.</strong>
              Merged {cleanedMelody.mergedCount} syllable fragment
              {cleanedMelody.mergedCount === 1 ? '' : 's'} into smoother melody
              notes.
            </div>
          ) : null}

          <Timeline
            rawNotes={rawTranscription?.notes ?? []}
            adjustedNotes={adjustedNotes}
            duration={source?.duration ?? rawTranscription?.duration ?? 8}
          />

          {source?.url ? (
            <audio className="audio-player" controls src={source.url}>
              <track kind="captions" />
            </audio>
          ) : (
            <div className="empty-state">
              <Play size={24} />
              <span>Load audio to inspect and correct the melody.</span>
            </div>
          )}
        </section>

        <aside className="inspector" aria-label="Analysis settings">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Correction</p>
              <h2>Musical intent</h2>
            </div>
            <SlidersHorizontal size={20} />
          </div>

          <SettingRow label="Key">
            <select
              value={settings.key}
              onChange={(event) =>
                updateSetting(
                  'key',
                  event.target.value as AnalysisSettings['key'],
                )
              }
            >
              {KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow label="Scale">
            <select
              value={settings.scale}
              onChange={(event) =>
                updateSetting(
                  'scale',
                  event.target.value as AnalysisSettings['scale'],
                )
              }
            >
              {SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {titleCase(scale)}
                </option>
              ))}
            </select>
          </SettingRow>

          <div className="suggestion">
            Suggested: {suggestedKey.key} {titleCase(suggestedKey.scale)}
            <span>{Math.round(suggestedKey.confidence * 100)}%</span>
          </div>

          <SettingRow label="Transpose">
            <input
              type="number"
              min={-24}
              max={24}
              value={settings.transpose}
              onChange={(event) =>
                updateSetting('transpose', Number(event.target.value))
              }
            />
          </SettingRow>

          <RangeSetting
            label="Articulation cleanup"
            value={settings.articulationCleanup}
            onChange={(value) => updateSetting('articulationCleanup', value)}
          />

          <RangeSetting
            label="Pitch correction"
            value={settings.correctionStrength}
            onChange={(value) => updateSetting('correctionStrength', value)}
          />

          <SettingRow label="BPM">
            <input
              type="number"
              min={40}
              max={240}
              value={settings.tempo}
              onChange={(event) =>
                updateSetting('tempo', Number(event.target.value))
              }
            />
          </SettingRow>

          <SettingRow label="Grid">
            <select
              value={settings.grid}
              onChange={(event) =>
                updateSetting('grid', Number(event.target.value))
              }
            >
              {GRID_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>

          <RangeSetting
            label="Rhythm quantize"
            value={settings.quantizeStrength}
            onChange={(value) => updateSetting('quantizeStrength', value)}
          />

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.exportPitchBends}
              onChange={(event) =>
                updateSetting('exportPitchBends', event.target.checked)
              }
            />
            Export pitch bends
          </label>
        </aside>
      </section>

      <section className="note-table-section">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Notes</p>
            <h2>Editable output</h2>
          </div>
          <span className="note-count">{adjustedNotes.length} notes</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Raw</th>
                <th>Corrected</th>
                <th>Start</th>
                <th>Duration</th>
                <th>Confidence</th>
                <th>Adjust</th>
              </tr>
            </thead>
            <tbody>
              {adjustedNotes.length > 0 ? (
                adjustedNotes.map((note) => (
                  <tr key={note.id}>
                    <td>{note.rawNoteName}</td>
                    <td>{note.noteName}</td>
                    <td>{formatSeconds(note.quantizedStart)}</td>
                    <td>{formatSeconds(note.quantizedDuration)}</td>
                    <td>{Math.round(note.confidence * 100)}%</td>
                    <td>
                      <div className="note-actions">
                        <button
                          type="button"
                          title="Raise one semitone"
                          onClick={() => nudgeNote(note.id, 1)}
                        >
                          <ChevronUp size={16} />
                        </button>
                        <button
                          type="button"
                          title="Lower one semitone"
                          onClick={() => nudgeNote(note.id, -1)}
                        >
                          <ChevronDown size={16} />
                        </button>
                        <button
                          type="button"
                          title="Reset note"
                          onClick={() => resetNote(note.id)}
                          disabled={!manualEdits[note.id]}
                        >
                          <RotateCcw size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="empty-row">
                    Analyze a recording to generate editable notes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default App

interface TimelineProps {
  rawNotes: RawTranscription['notes']
  adjustedNotes: AdjustedNote[]
  duration: number
}

function Timeline({ rawNotes, adjustedNotes, duration }: TimelineProps) {
  const notes = [...rawNotes, ...adjustedNotes]
  const minMidi = Math.min(55, ...notes.map((note) => Math.round(note.midi) - 2))
  const maxMidi = Math.max(76, ...notes.map((note) => Math.round(note.midi) + 2))
  const midiRange = Math.max(1, maxMidi - minMidi)
  const safeDuration = Math.max(1, duration)

  function xFor(seconds: number) {
    return (seconds / safeDuration) * 1000
  }

  function yFor(midi: number) {
    return 260 - ((midi - minMidi) / midiRange) * 220
  }

  return (
    <svg className="timeline" viewBox="0 0 1000 300" role="img">
      <title>Detected and corrected note timeline</title>
      {Array.from({ length: 9 }, (_, index) => {
        const x = (index / 8) * 1000
        return <line key={`time-${index}`} x1={x} y1="24" x2={x} y2="270" />
      })}
      {Array.from({ length: 7 }, (_, index) => {
        const y = 40 + index * 36
        return <line key={`pitch-${index}`} x1="0" y1={y} x2="1000" y2={y} />
      })}
      {rawNotes.map((note) => (
        <rect
          key={`raw-${note.id}`}
          className="raw-note"
          x={xFor(note.start)}
          y={yFor(note.midi) - 7}
          width={Math.max(4, xFor(note.duration))}
          height="14"
          rx="3"
        />
      ))}
      {adjustedNotes.map((note) => (
        <rect
          key={`adjusted-${note.id}`}
          className="adjusted-note"
          x={xFor(note.quantizedStart)}
          y={yFor(note.midi) - 9}
          width={Math.max(5, xFor(note.quantizedDuration))}
          height="18"
          rx="4"
        />
      ))}
    </svg>
  )
}

interface SettingRowProps {
  label: string
  children: ReactNode
}

function SettingRow({ label, children }: SettingRowProps) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

interface RangeSettingProps {
  label: string
  value: number
  onChange: (value: number) => void
}

function RangeSetting({ label, value, onChange }: RangeSettingProps) {
  return (
    <label className="setting-row range-row">
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong>{Math.round(value * 100)}%</strong>
    </label>
  )
}

function preferredMimeType(): string {
  if (!('MediaRecorder' in window)) {
    return ''
  }

  return (
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    ) ?? ''
  )
}

function statusLabel(status: AppStatus): string {
  switch (status) {
    case 'recording':
      return 'Recording'
    case 'analyzing':
      return 'Analyzing'
    case 'ready':
      return 'Ready'
    case 'complete':
      return 'Notes ready'
    case 'idle':
      return 'Idle'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}
