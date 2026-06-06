import {
  Download,
  LoaderCircle,
  Mic,
  Play,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Square,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { decodeBlobToAudioSource } from './lib/audio'
import { liveKeyWheelNotes } from './lib/keyWheel'
import {
  LIVE_FRAME_SIZE,
  analyzeLiveFrame,
  calibrateSilenceFromFrames,
  calibrateVoiceFromFrames,
  classifyTrigger,
  cleanupCapturedClip,
  createLiveEngineState,
  effectiveInputThreshold,
  extractTriggerFeature,
  mergeClipWithBasicPitch,
  scaledRmsThreshold,
  type LiveEngineState,
} from './lib/liveEngine'
import { createPerformanceMidiBlob } from './lib/midi'
import { midiToNoteName } from './lib/music'
import { playPianoNotes, type PlaybackHandle } from './lib/playback'
import { createDefaultProfile, loadProfile, saveProfile } from './lib/profile'
import { KEYS, SCALES } from './lib/types'
import type {
  CapturedClip,
  CcMapping,
  CcSource,
  KeyName,
  LivePitchFrame,
  PerformanceEvent,
  PitchBendEvent,
  PitchBendMode,
  ScaleName,
  TriggerEvent,
  TriggerSlot,
  VocalProfile,
} from './lib/types'

type ControllerStatus =
  | 'idle'
  | 'monitoring'
  | 'capturing'
  | 'processing'
  | 'calibrating'

interface ActiveVoice {
  oscillators: OscillatorNode[]
  gain: GainNode
}

const CC_SOURCES: Array<{ value: CcSource; label: string }> = [
  { value: 'envelope', label: 'Envelope' },
  { value: 'ah', label: 'Ah' },
  { value: 'ee', label: 'Ee' },
  { value: 'oo', label: 'Oo' },
]

function App() {
  const [profile, setProfile] = useState<VocalProfile>(() => loadProfile())
  const [status, setStatus] = useState<ControllerStatus>('idle')
  const [latestFrame, setLatestFrame] = useState<LivePitchFrame | null>(null)
  const [recentFrames, setRecentFrames] = useState<LivePitchFrame[]>([])
  const [clip, setClip] = useState<CapturedClip | null>(null)
  const [progress, setProgress] = useState(0)
  const [tempo, setTempo] = useState(120)
  const [error, setError] = useState('')
  const [calibrationMessage, setCalibrationMessage] = useState('')
  const [isPlayingClip, setIsPlayingClip] = useState(false)

  const profileRef = useRef(profile)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const inputGainRef = useRef<GainNode | null>(null)
  const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const silentGainRef = useRef<GainNode | null>(null)
  const filterRef = useRef<BiquadFilterNode | null>(null)
  const masterRef = useRef<GainNode | null>(null)
  const engineStateRef = useRef<LiveEngineState>(createLiveEngineState())
  const sessionStartedAtRef = useRef(0)
  const captureStartedAtRef = useRef(0)
  const isCapturingRef = useRef(false)
  const capturedFramesRef = useRef<LivePitchFrame[]>([])
  const capturedEventsRef = useRef<PerformanceEvent[]>([])
  const lastSamplesRef = useRef<Float32Array | null>(null)
  const lastTriggerAtRef = useRef(-1)
  const liveFrameCounterRef = useRef(0)
  const activeVoicesRef = useRef<Map<number, ActiveVoice>>(new Map())
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const pendingLiveClipRef = useRef<CapturedClip | null>(null)
  const stopMicAfterProcessingRef = useRef(false)
  const isStartingMicRef = useRef(false)
  const playbackRef = useRef<PlaybackHandle | null>(null)

  const latestNote = latestFrame?.lockedMidi
    ? midiToNoteName(latestFrame.lockedMidi)
    : '...'
  const latestCents = latestFrame ? Math.round(latestFrame.centsOffset) : 0
  const profileCompleteness = useMemo(() => {
    const trained = profile.triggers.filter((slot) => slot.examples.length >= 5).length
    return Math.round((trained / profile.triggers.length) * 100)
  }, [profile.triggers])

  useEffect(() => {
    profileRef.current = profile
    saveProfile(profile)
  }, [profile])

  useEffect(() => {
    const context = audioContextRef.current
    const inputGain = inputGainRef.current
    if (!context || !inputGain) {
      return
    }

    inputGain.gain.setTargetAtTime(profile.pitch.inputLevel, context.currentTime, 0.015)
  }, [profile.pitch.inputLevel])

  useEffect(() => {
    const activeVoices = activeVoicesRef.current

    return () => {
      playbackRef.current?.stop()
      activeVoices.forEach((voice) => {
        voice.oscillators.forEach((oscillator) => {
          try {
            oscillator.stop()
          } catch {
            // Audio nodes may already be stopped during normal shutdown.
          }
        })
        voice.gain.disconnect()
      })
      processorRef.current?.disconnect()
      sourceNodeRef.current?.disconnect()
      inputGainRef.current?.disconnect()
      recordingDestinationRef.current?.disconnect()
      silentGainRef.current?.disconnect()
      masterRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      void audioContextRef.current?.close()
    }
  }, [])

  async function startSession() {
    if (isStartingMicRef.current || status !== 'idle') {
      return
    }

    isStartingMicRef.current = true
    try {
      await startMic(true)
    } finally {
      isStartingMicRef.current = false
    }
  }

  function stopSession() {
    if (status === 'capturing') {
      stopCapture(true)
      return
    }

    stopMic()
  }

  async function startMic(startCapturing: boolean) {
    try {
      setError('')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      })
      const context = new AudioContext()
      await context.resume()

      const sourceNode = context.createMediaStreamSource(stream)
      const inputGain = context.createGain()
      inputGain.gain.value = profileRef.current.pitch.inputLevel
      const recordingDestination = context.createMediaStreamDestination()
      const processor = context.createScriptProcessor(LIVE_FRAME_SIZE, 1, 1)
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      const master = context.createGain()
      master.gain.value = 0.34
      const filter = context.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 1800
      filter.Q.value = 0.8
      master.connect(filter)
      filter.connect(context.destination)

      sessionStartedAtRef.current = context.currentTime
      engineStateRef.current = createLiveEngineState()
      sourceNode.connect(inputGain)
      inputGain.connect(processor)
      inputGain.connect(recordingDestination)
      processor.connect(silentGain)
      silentGain.connect(context.destination)
      processor.onaudioprocess = handleAudioProcess

      audioContextRef.current = context
      streamRef.current = stream
      sourceNodeRef.current = sourceNode
      inputGainRef.current = inputGain
      recordingDestinationRef.current = recordingDestination
      processorRef.current = processor
      silentGainRef.current = silentGain
      masterRef.current = master
      filterRef.current = filter

      if ('MediaRecorder' in window) {
        const mimeType = preferredMimeType()
        mediaRecorderRef.current = new MediaRecorder(
          recordingDestination.stream,
          mimeType ? { mimeType } : undefined,
        )
        mediaRecorderRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recorderChunksRef.current.push(event.data)
          }
        }
        mediaRecorderRef.current.onstop = () => {
          void finishBasicPitchMerge(mimeType || 'audio/webm')
        }
      }

      if (startCapturing) {
        beginCapture(context)
      } else {
        setStatus('monitoring')
      }
    } catch (startError) {
      setError(errorMessage(startError))
      setStatus('idle')
    }
  }

  function stopMic() {
    if (isCapturingRef.current) {
      stopCapture(true)
      return
    }

    releaseMicHardware()
    setStatus('idle')
  }

  function beginCapture(context: AudioContext) {
    if (isCapturingRef.current) {
      return
    }

    stopClipPlayback()
    setError('')
    setProgress(0)
    setClip(null)
    capturedFramesRef.current = []
    capturedEventsRef.current = []
    recorderChunksRef.current = []
    pendingLiveClipRef.current = null
    captureStartedAtRef.current = context.currentTime - sessionStartedAtRef.current
    isCapturingRef.current = true

    if (mediaRecorderRef.current?.state === 'inactive') {
      mediaRecorderRef.current.start()
    }

    setStatus('capturing')
  }

  function stopCapture(stopMicAfterProcessing = false) {
    if (!isCapturingRef.current) {
      return
    }

    stopMicAfterProcessingRef.current = stopMicAfterProcessing
    const context = audioContextRef.current
    const now =
      context && sessionStartedAtRef.current
        ? context.currentTime - sessionStartedAtRef.current
        : latestFrame?.time ?? 0
    const duration = Math.max(0.05, now - captureStartedAtRef.current)
    const activeMidi = engineStateRef.current.activeMidi
    if (activeMidi !== null) {
      capturedEventsRef.current.push({
        id: `capture-stop-${now}`,
        type: 'noteOff',
        time: duration,
        midi: activeMidi,
      })
      engineStateRef.current.activeMidi = null
      engineStateRef.current.activePeakRms = 0
      engineStateRef.current.activeLowEnergyFrames = 0
    }

    isCapturingRef.current = false
    setStatus('processing')
    const liveClip = cleanupCapturedClip({
      frames: capturedFramesRef.current,
      events: capturedEventsRef.current,
      duration,
      profile: profileRef.current,
    })
    pendingLiveClipRef.current = liveClip
    setClip(liveClip)

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    } else {
      if (stopMicAfterProcessing) {
        releaseMicHardware()
        setStatus('idle')
      } else {
        setStatus(audioContextRef.current ? 'monitoring' : 'idle')
      }
    }
  }

  async function finishBasicPitchMerge(mimeType: string) {
    const liveClip = pendingLiveClipRef.current
    if (!liveClip) {
      setStatus(audioContextRef.current ? 'monitoring' : 'idle')
      return
    }

    try {
      const blob = new Blob(recorderChunksRef.current, { type: mimeType })
      if (blob.size === 0) {
        setStatus(audioContextRef.current ? 'monitoring' : 'idle')
        return
      }

      const source = await decodeBlobToAudioSource(blob, 'Vocal capture')
      const { transcribeWithBasicPitch } = await import('./lib/transcription')
      const raw = await transcribeWithBasicPitch(source.buffer, setProgress)
      const merged = mergeClipWithBasicPitch(liveClip, raw.notes, profileRef.current)
      setClip(merged)
      updateProfile((current) => ({
        ...current,
        pitch: {
          ...current.pitch,
          key: merged.suggestedKey.key,
          scale: merged.suggestedKey.scale,
        },
      }))
    } catch (mergeError) {
      setError(`Live capture saved; Basic Pitch cleanup failed: ${errorMessage(mergeError)}`)
    } finally {
      const shouldStopMic = stopMicAfterProcessingRef.current
      stopMicAfterProcessingRef.current = false
      if (shouldStopMic) {
        releaseMicHardware()
      }
      setStatus(shouldStopMic ? 'idle' : audioContextRef.current ? 'monitoring' : 'idle')
      setProgress(0)
      recorderChunksRef.current = []
      pendingLiveClipRef.current = null
    }
  }

  function handleAudioProcess(event: AudioProcessingEvent) {
    const context = audioContextRef.current
    if (!context) {
      return
    }

    const input = event.inputBuffer.getChannelData(0)
    const samples = new Float32Array(input)
    lastSamplesRef.current = samples
    const time = context.currentTime - sessionStartedAtRef.current
    const result = analyzeLiveFrame(
      samples,
      context.sampleRate,
      time,
      profileRef.current,
      engineStateRef.current,
    )
    const events = [...result.events]

    const triggerEvent = triggerEventForFrame(samples, result.frame)
    if (triggerEvent) {
      events.push(triggerEvent)
    }

    if (!isCapturingRef.current) {
      playLiveEvents(events)
    }
    recordLiveData(result.frame, events)

    liveFrameCounterRef.current += 1
    if (liveFrameCounterRef.current % 3 === 0) {
      setLatestFrame(result.frame)
      setRecentFrames((current) => [...current.slice(-140), result.frame])
    }
  }

  function recordLiveData(frame: LivePitchFrame, events: PerformanceEvent[]) {
    if (!isCapturingRef.current) {
      return
    }

    const offset = captureStartedAtRef.current
    capturedFramesRef.current.push({
      ...frame,
      time: Math.max(0, frame.time - offset),
    })
    capturedEventsRef.current.push(
      ...events.map((event) => ({
        ...event,
        time: Math.max(0, event.time - offset),
      })),
    )
  }

  function triggerEventForFrame(
    samples: Float32Array,
    frame: LivePitchFrame,
  ): TriggerEvent | null {
    if (frame.voiced) {
      return null
    }

    const triggerThreshold = scaledRmsThreshold(
      profileRef.current.calibration,
      profileRef.current.pitch.inputLevel,
    )
    if (
      frame.rms < triggerThreshold * 1.75 ||
      frame.time - lastTriggerAtRef.current < 0.12
    ) {
      return null
    }

    const feature = extractTriggerFeature(samples)
    const slot = classifyTrigger(feature, profileRef.current.triggers)
    if (!slot) {
      return null
    }

    lastTriggerAtRef.current = frame.time
    return {
      id: `trigger-${slot.id}-${frame.time}`,
      type: 'trigger',
      time: frame.time,
      midi: slot.midi,
      velocity: Math.max(0.1, Math.min(1, frame.rms / profileRef.current.calibration.vocalRms)),
      slotId: slot.id,
    }
  }

  function calibrateSilence() {
    if (recentFrames.length === 0) {
      return
    }

    setStatus('calibrating')
    const frames = recentFrames.slice(-40)
    const calibration = calibrateSilenceFromFrames(
      profileRef.current.calibration,
      frames,
      profileRef.current.pitch.inputLevel,
    )
    if (!calibration) {
      setCalibrationMessage('Silence calibration needs a few more frames.')
    } else {
      setCalibrationMessage('Silence floor captured.')
      updateProfile((current) => ({
        ...current,
        calibration,
      }))
    }
    window.setTimeout(() => setStatus(audioContextRef.current ? 'monitoring' : 'idle'), 180)
  }

  function calibrateVoice() {
    if (recentFrames.length === 0) {
      return
    }

    setStatus('calibrating')
    const frames = recentFrames.slice(-90)
    const update = calibrateVoiceFromFrames(
      profileRef.current.calibration,
      frames,
      profileRef.current.pitch.inputLevel,
    )
    if (!update) {
      setCalibrationMessage('Voice calibration needs a louder or longer hold.')
    } else {
      setCalibrationMessage(calibrationFeedbackLabel(update.feedback))
      updateProfile((current) => ({
        ...current,
        calibration: update.calibration,
      }))
    }
    window.setTimeout(() => setStatus(audioContextRef.current ? 'monitoring' : 'idle'), 180)
  }

  function trainTrigger(slotId: string) {
    const samples = lastSamplesRef.current
    if (!samples) {
      return
    }

    const feature = extractTriggerFeature(samples)
    updateProfile((current) => ({
      ...current,
      triggers: current.triggers.map((slot) =>
        slot.id === slotId
          ? {
              ...slot,
              examples: [...slot.examples, feature].slice(-5),
            }
          : slot,
      ),
    }))
  }

  function resetTrigger(slotId: string) {
    updateProfile((current) => ({
      ...current,
      triggers: current.triggers.map((slot) =>
        slot.id === slotId ? { ...slot, examples: [] } : slot,
      ),
    }))
  }

  function exportMidi() {
    if (!clip) {
      return
    }

    const blob = createPerformanceMidiBlob(clip, tempo)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'vocal-controller-capture.mid'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function toggleClipPlayback() {
    if (isPlayingClip) {
      stopClipPlayback()
      return
    }

    if (!clip || clip.cleanedNotes.length === 0) {
      return
    }

    try {
      setIsPlayingClip(true)
      playbackRef.current = await playPianoNotes(clip.cleanedNotes, () => {
        playbackRef.current = null
        setIsPlayingClip(false)
      })
    } catch (playError) {
      setError(errorMessage(playError))
      setIsPlayingClip(false)
    }
  }

  function stopClipPlayback() {
    playbackRef.current?.stop()
    playbackRef.current = null
    setIsPlayingClip(false)
  }

  function resetProfile() {
    stopAllVoices()
    setProfile(createDefaultProfile())
  }

  function updateProfile(updater: (profile: VocalProfile) => VocalProfile) {
    setProfile((current) => updater(current))
  }

  function playLiveEvents(events: PerformanceEvent[]) {
    if (!audioContextRef.current || !masterRef.current) {
      return
    }

    events.forEach((event) => {
      if (event.type === 'noteOn') {
        playNote(event.midi, event.velocity)
      } else if (event.type === 'noteOff') {
        stopNote(event.midi)
      } else if (event.type === 'pitchBend') {
        bendNote(event)
      } else if (event.type === 'trigger') {
        playTrigger(event)
      } else if (event.type === 'cc') {
        applyCc(event.cc, event.value)
      }
    })
  }

  function playNote(midi: number, velocity: number) {
    const context = audioContextRef.current
    const master = masterRef.current
    if (!context || !master || activeVoicesRef.current.has(midi)) {
      return
    }

    ;[...activeVoicesRef.current.keys()].forEach((activeMidi) => {
      if (activeMidi !== midi) {
        stopNote(activeMidi)
      }
    })

    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.02, velocity * 0.18),
      context.currentTime + 0.012,
    )
    gain.connect(master)

    const oscillators = ['sawtooth', 'triangle'].map((type, index) => {
      const oscillator = context.createOscillator()
      oscillator.type = type as OscillatorType
      oscillator.frequency.value = midiToFrequency(midi) * (index === 0 ? 1 : 2)
      oscillator.connect(gain)
      oscillator.start()
      return oscillator
    })

    activeVoicesRef.current.set(midi, { oscillators, gain })
  }

  function stopNote(midi: number) {
    const context = audioContextRef.current
    const voice = activeVoicesRef.current.get(midi)
    if (!context || !voice) {
      return
    }

    voice.gain.gain.cancelScheduledValues(context.currentTime)
    voice.gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.04)
    voice.oscillators.forEach((oscillator) => {
      oscillator.stop(context.currentTime + 0.18)
    })
    window.setTimeout(() => voice.gain.disconnect(), 220)
    activeVoicesRef.current.delete(midi)
  }

  function bendNote(event: PitchBendEvent) {
    const context = audioContextRef.current
    const voice = activeVoicesRef.current.get(event.midi)
    if (!context || !voice) {
      return
    }

    voice.oscillators.forEach((oscillator) => {
      oscillator.detune.setTargetAtTime(event.value * 200, context.currentTime, 0.018)
    })
  }

  function playTrigger(event: TriggerEvent) {
    const context = audioContextRef.current
    const master = masterRef.current
    if (!context || !master) {
      return
    }

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'square'
    oscillator.frequency.value = event.midi <= 38 ? 84 : event.midi <= 40 ? 180 : 640
    gain.gain.setValueAtTime(Math.max(0.02, event.velocity * 0.28), context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.09)
    window.setTimeout(() => gain.disconnect(), 120)
  }

  function applyCc(cc: number, value: number) {
    const filter = filterRef.current
    const context = audioContextRef.current
    if (!filter || !context) {
      return
    }

    const normalized = value / 127
    if (cc === 74 || cc === 71 || cc === 1 || cc === 11) {
      filter.frequency.setTargetAtTime(600 + normalized * 5200, context.currentTime, 0.035)
      filter.Q.setTargetAtTime(0.6 + normalized * 5, context.currentTime, 0.05)
    }
  }

  function stopAllVoices() {
    ;[...activeVoicesRef.current.keys()].forEach((midi) => stopNote(midi))
  }

  function releaseMicHardware() {
    stopAllVoices()
    processorRef.current?.disconnect()
    sourceNodeRef.current?.disconnect()
    inputGainRef.current?.disconnect()
    recordingDestinationRef.current?.disconnect()
    silentGainRef.current?.disconnect()
    masterRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void audioContextRef.current?.close()

    audioContextRef.current = null
    streamRef.current = null
    sourceNodeRef.current = null
    inputGainRef.current = null
    recordingDestinationRef.current = null
    processorRef.current = null
    silentGainRef.current = null
    masterRef.current = null
    filterRef.current = null
    mediaRecorderRef.current = null
    isCapturingRef.current = false
  }

  return (
    <main className="controller-shell">
      <header className="controller-topbar">
        <div>
          <p className="eyebrow">Music Copilot / Vocal MIDI controller</p>
          <h1>Voice Controller</h1>
        </div>
        <div className="status-pill">
          <span className={`status-dot status-${status}`} />
          {statusLabel(status)}
        </div>
      </header>

      <section className="transport controller-transport" aria-label="Transport">
        <button
          className="primary-action"
          type="button"
          onClick={status === 'idle' ? startSession : stopSession}
          disabled={status === 'processing' || status === 'calibrating'}
          title={status === 'idle' ? 'Start capture' : 'Stop capture'}
        >
          {status === 'idle' ? <Mic size={18} /> : <Square size={18} />}
          {status === 'idle' ? 'Start capture' : 'Stop capture'}
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={toggleClipPlayback}
          disabled={!clip || clip.cleanedNotes.length === 0}
          title={isPlayingClip ? 'Stop clip playback' : 'Play captured clip'}
        >
          {isPlayingClip ? <Square size={18} /> : <Play size={18} />}
          {isPlayingClip ? 'Stop clip' : 'Play clip'}
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={exportMidi}
          disabled={!clip}
          title="Export captured MIDI"
        >
          <Download size={18} />
          Export MIDI
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => saveProfile(profile)}
          title="Save profile"
        >
          <Save size={18} />
          Save profile
        </button>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}
      {status === 'processing' ? (
        <div className="progress-track" aria-label="Post capture cleanup progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}

      <section className="controller-grid">
        <section className="pitch-stage" aria-label="Pitch wheel">
          <KeyConfidenceWheel
            note={latestNote}
            cents={latestCents}
            confidence={latestFrame?.confidence ?? 0}
            rms={latestFrame?.rms ?? 0}
            threshold={effectiveInputThreshold(
              profile.calibration,
              profile.pitch.inputLevel,
            )}
            voiced={latestFrame?.voiced ?? false}
            keyName={profile.pitch.key}
            scaleName={profile.pitch.scale}
            keyLock={profile.pitch.keyLock}
            lockedMidi={latestFrame?.lockedMidi ?? null}
          />
          <div className="mode-readout">
            <span>{profile.pitch.bendMode === 'intellibend' ? 'IntelliBend' : 'TruBend'}</span>
            <span>{profile.pitch.keyLock ? `${profile.pitch.key} ${profile.pitch.scale}` : 'Chromatic'}</span>
            <span>Mono note output</span>
          </div>
          <LiveTimeline frames={recentFrames} clip={clip} />
        </section>

        <aside className="profile-panel" aria-label="Profile and calibration">
          <PanelHeading eyebrow="Profile" title={profile.name}>
            <SlidersHorizontal size={18} />
          </PanelHeading>
          <SettingRow label="Profile name">
            <input
              value={profile.name}
              onChange={(event) =>
                updateProfile((current) => ({ ...current, name: event.target.value }))
              }
            />
          </SettingRow>
          <RangeSetting
            label="Input level"
            value={profile.pitch.inputLevel}
            min={0.25}
            max={2.5}
            step={0.01}
            suffix="x"
            onChange={(value) =>
              updateProfile((current) => ({
                ...current,
                pitch: { ...current.pitch, inputLevel: value },
              }))
            }
          />
          <div className="calibration-grid">
            <button type="button" onClick={calibrateSilence} disabled={status === 'idle'}>
              Calibrate silence
            </button>
            <button type="button" onClick={calibrateVoice} disabled={status === 'idle'}>
              Calibrate voice
            </button>
          </div>
          {calibrationMessage ? (
            <p className="calibration-message">{calibrationMessage}</p>
          ) : null}
          <div className="meter-list">
            <Meter label="Noise" value={profile.calibration.noiseFloorRms} max={0.2} />
            <Meter label="Voice" value={profile.calibration.vocalRms} max={0.4} />
            <Meter label="Threshold" value={profile.calibration.rmsThreshold} max={0.2} />
          </div>
          <div className="profile-health">
            <strong>{profileCompleteness}% trigger training</strong>
            <span>Five examples per slot gives the classifier enough shape.</span>
          </div>
          <button className="secondary-danger" type="button" onClick={resetProfile}>
            <RotateCcw size={16} />
            Reset profile
          </button>
        </aside>
      </section>

      <section className="control-matrix" aria-label="Controller modes">
        <ModePanel title="Pitch" eyebrow="Notes and bends">
          <SettingRow label="Key">
            <select
              value={profile.pitch.key}
              onChange={(event) =>
                updateProfile((current) => ({
                  ...current,
                  pitch: { ...current.pitch, key: event.target.value as KeyName },
                }))
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
              value={profile.pitch.scale}
              onChange={(event) =>
                updateProfile((current) => ({
                  ...current,
                  pitch: { ...current.pitch, scale: event.target.value as ScaleName },
                }))
              }
            >
              {SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {titleCase(scale)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Bend">
            <select
              value={profile.pitch.bendMode}
              onChange={(event) =>
                updateProfile((current) => ({
                  ...current,
                  pitch: {
                    ...current.pitch,
                    bendMode: event.target.value as PitchBendMode,
                  },
                }))
              }
            >
              <option value="intellibend">IntelliBend</option>
              <option value="trubend">TruBend</option>
            </select>
          </SettingRow>
          <RangeSetting
            label="Pitch stickiness"
            value={profile.pitch.stickiness}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) =>
              updateProfile((current) => ({
                ...current,
                pitch: { ...current.pitch, stickiness: value },
              }))
            }
          />
          <SettingRow label="Octave">
            <input
              type="number"
              min={-3}
              max={3}
              value={profile.pitch.octave}
              onChange={(event) =>
                updateProfile((current) => ({
                  ...current,
                  pitch: { ...current.pitch, octave: Number(event.target.value) },
                }))
              }
            />
          </SettingRow>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={profile.pitch.keyLock}
              onChange={(event) =>
                updateProfile((current) => ({
                  ...current,
                  pitch: { ...current.pitch, keyLock: event.target.checked },
                }))
              }
            />
            Key lock
          </label>
        </ModePanel>

        <ModePanel title="Triggers" eyebrow="Percussive slots">
          <div className="trigger-list">
            {profile.triggers.map((slot) => (
              <TriggerSlotRow
                key={slot.id}
                slot={slot}
                onTrain={() => trainTrigger(slot.id)}
                onReset={() => resetTrigger(slot.id)}
                onToggle={(enabled) =>
                  updateProfile((current) => ({
                    ...current,
                    triggers: current.triggers.map((candidate) =>
                      candidate.id === slot.id ? { ...candidate, enabled } : candidate,
                    ),
                  }))
                }
                onMidiChange={(midi) =>
                  updateProfile((current) => ({
                    ...current,
                    triggers: current.triggers.map((candidate) =>
                      candidate.id === slot.id ? { ...candidate, midi } : candidate,
                    ),
                  }))
                }
              />
            ))}
          </div>
        </ModePanel>

        <ModePanel title="CC" eyebrow="Voice-controlled effects">
          <div className="cc-list">
            {profile.ccMappings.map((mapping) => (
              <CcMappingRow
                key={mapping.id}
                mapping={mapping}
                onChange={(next) =>
                  updateProfile((current) => ({
                    ...current,
                    ccMappings: current.ccMappings.map((candidate) =>
                      candidate.id === mapping.id ? next : candidate,
                    ),
                  }))
                }
              />
            ))}
          </div>
          <RangeSetting
            label="Smoothing"
            value={profile.ccSmoothing}
            min={0}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              updateProfile((current) => ({
                ...current,
                ccSmoothing: value,
              }))
            }
          />
        </ModePanel>
      </section>

      <section className="capture-panel" aria-label="Capture output">
        <PanelHeading eyebrow="Capture" title="Cleaned MIDI clip">
          {status === 'processing' ? <LoaderCircle className="spin" size={18} /> : null}
        </PanelHeading>
        <div className="capture-stats">
          <Stat label="Duration" value={clip ? `${clip.duration.toFixed(2)}s` : '0.00s'} />
          <Stat label="Notes" value={clip ? String(clip.cleanedNotes.length) : '0'} />
          <Stat
            label="Suggested key"
            value={clip ? `${clip.suggestedKey.key} ${clip.suggestedKey.scale}` : `${profile.pitch.key} ${profile.pitch.scale}`}
          />
          <label className="tempo-control">
            <span>BPM</span>
            <input
              type="number"
              min={40}
              max={240}
              value={tempo}
              onChange={(event) => setTempo(Number(event.target.value))}
            />
          </label>
        </div>
        <CapturedNotesTable clip={clip} />
      </section>
    </main>
  )
}

export default App

interface KeyConfidenceWheelProps {
  note: string
  cents: number
  confidence: number
  rms: number
  threshold: number
  voiced: boolean
  keyName: KeyName
  scaleName: ScaleName
  keyLock: boolean
  lockedMidi: number | null
}

function KeyConfidenceWheel({
  note,
  cents,
  confidence,
  rms,
  threshold,
  voiced,
  keyName,
  scaleName,
  keyLock,
  lockedMidi,
}: KeyConfidenceWheelProps) {
  const wheelNotes = liveKeyWheelNotes(keyName, scaleName, keyLock)
  const activeChroma =
    lockedMidi === null ? null : ((Math.round(lockedMidi) % 12) + 12) % 12
  const activeIndex = wheelNotes.findIndex((wheelNote) => wheelNote.chroma === activeChroma)
  const inputStrength = clamp(rms / Math.max(0.001, threshold * 4), 0, 1)
  const strength = voiced ? clamp(confidence * 0.68 + inputStrength * 0.32, 0, 1) : 0
  const segmentAngle = 360 / wheelNotes.length
  const activeAngle =
    activeIndex >= 0
      ? activeIndex * segmentAngle - 90 + clamp(cents / 50, -0.42, 0.42) * segmentAngle
      : -90
  const rayEnd = polarPoint(150, 150, 62 + strength * 60, activeAngle)
  const displayNote = stripOctave(note)

  return (
    <div className={voiced ? 'pitch-wheel active' : 'pitch-wheel'}>
      <svg className="key-wheel-svg" viewBox="0 0 300 300" role="img">
        <title>
          {keyName} {scaleName} confidence wheel
        </title>
        {wheelNotes.map((wheelNote, index) => {
          const isActive = index === activeIndex && voiced
          const isVisible = wheelNote.visible
          const startAngle = index * segmentAngle - 105 + 1.1
          const endAngle = (index + 1) * segmentAngle - 105 - 1.1
          const labelAngle = startAngle + segmentAngle / 2
          const outerRadius = 106 + (isActive ? strength * 30 : 0)
          const labelRadius = isActive ? 96 + strength * 5 : 94

          return (
            <g key={wheelNote.label}>
              <path
                className={[
                  'wheel-segment',
                  isVisible ? 'visible-note' : 'muted-note',
                  isActive ? 'current' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                d={ringSegmentPath(150, 150, 72, outerRadius, startAngle, endAngle)}
                style={{
                  opacity: isActive ? 0.78 + strength * 0.22 : isVisible ? 1 : 0.34,
                }}
              />
              <text
                className={[
                  'wheel-label',
                  isVisible ? 'visible-note' : 'muted-note',
                  isActive ? 'current' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                x={polarPoint(150, 150, labelRadius, labelAngle).x}
                y={polarPoint(150, 150, labelRadius, labelAngle).y}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {wheelNote.label}
              </text>
            </g>
          )
        })}
        {voiced && activeIndex >= 0 ? (
          <line
            className="wheel-ray"
            x1="150"
            y1="150"
            x2={rayEnd.x}
            y2={rayEnd.y}
            style={{
              strokeWidth: 8 + strength * 17,
              opacity: 0.22 + strength * 0.46,
            }}
          />
        ) : null}
        <circle className="wheel-inner-ring" cx="150" cy="150" r="68" />
        <circle className="wheel-inner-shadow" cx="150" cy="150" r="48" />
        <circle className="wheel-core" cx="150" cy="150" r="31" />
        <text className="wheel-center-note" x="150" y="145" textAnchor="middle">
          {displayNote}
        </text>
        <text className="wheel-center-cents" x="150" y="174" textAnchor="middle">
          {cents > 0 ? '+' : ''}
          {cents} cents
        </text>
      </svg>
      <div className="wheel-meters">
        <Meter label="Confidence" value={confidence} max={1} />
        <div className="horizontal-meter">
          <span>Input</span>
          <strong>{Math.round(inputStrength * 100)}%</strong>
          <i style={{ width: `${inputStrength * 100}%` }} />
        </div>
        <div className="horizontal-meter">
          <span>Strength</span>
          <strong>{Math.round(strength * 100)}%</strong>
          <i style={{ width: `${strength * 100}%` }} />
        </div>
      </div>
    </div>
  )
}

interface LiveTimelineProps {
  frames: LivePitchFrame[]
  clip: CapturedClip | null
}

function LiveTimeline({ frames, clip }: LiveTimelineProps) {
  const voiced = frames.filter((frame) => frame.lockedMidi !== null)
  const minMidi = Math.min(48, ...voiced.map((frame) => (frame.lockedMidi ?? 60) - 2))
  const maxMidi = Math.max(84, ...voiced.map((frame) => (frame.lockedMidi ?? 60) + 2))
  const midiRange = Math.max(1, maxMidi - minMidi)
  const startTime = frames[0]?.time ?? 0
  const duration = Math.max(1, (frames[frames.length - 1]?.time ?? 1) - startTime)

  function xFor(time: number) {
    return ((time - startTime) / duration) * 900 + 20
  }

  function yFor(midi: number) {
    return 180 - ((midi - minMidi) / midiRange) * 140
  }

  return (
    <svg className="live-timeline" viewBox="0 0 940 220" role="img">
      <title>Live pitch and captured notes</title>
      {Array.from({ length: 8 }, (_, index) => (
        <line key={`grid-${index}`} x1={20 + index * 128} x2={20 + index * 128} y1="24" y2="190" />
      ))}
      {voiced.map((frame, index) => (
        <circle
          key={`${frame.time}-${index}`}
          cx={xFor(frame.time)}
          cy={yFor(frame.lockedMidi ?? 60)}
          r={Math.max(2, frame.confidence * 5)}
        />
      ))}
      {clip?.cleanedNotes.map((note) => (
        <rect
          key={note.id}
          x={(note.start / Math.max(1, clip.duration)) * 900 + 20}
          y={yFor(note.midi) - 8}
          width={Math.max(5, (note.duration / Math.max(1, clip.duration)) * 900)}
          height="16"
          rx="3"
        />
      ))}
    </svg>
  )
}

function PanelHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="panel-heading compact-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function ModePanel({
  title,
  eyebrow,
  children,
}: {
  title: string
  eyebrow: string
  children: ReactNode
}) {
  return (
    <section className="mode-panel">
      <PanelHeading eyebrow={eyebrow} title={title} />
      {children}
    </section>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

function RangeSetting({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const displayValue =
    suffix || max > 1 ? `${value.toFixed(suffix ? 2 : 0)}${suffix}` : `${Math.round(value * 100)}%`

  return (
    <label className="setting-row range-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong>{displayValue}</strong>
    </label>
  )
}

function TriggerSlotRow({
  slot,
  onTrain,
  onReset,
  onToggle,
  onMidiChange,
}: {
  slot: TriggerSlot
  onTrain: () => void
  onReset: () => void
  onToggle: (enabled: boolean) => void
  onMidiChange: (midi: number) => void
}) {
  return (
    <div className="trigger-slot">
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={slot.enabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <strong>{slot.label}</strong>
      </label>
      <input
        type="number"
        min={0}
        max={127}
        value={slot.midi}
        onChange={(event) => onMidiChange(Number(event.target.value))}
      />
      <span>{slot.examples.length}/5</span>
      <button type="button" onClick={onTrain}>
        Train
      </button>
      <button type="button" onClick={onReset}>
        Reset
      </button>
    </div>
  )
}

function CcMappingRow({
  mapping,
  onChange,
}: {
  mapping: CcMapping
  onChange: (mapping: CcMapping) => void
}) {
  return (
    <div className="cc-row">
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={mapping.enabled}
          onChange={(event) => onChange({ ...mapping, enabled: event.target.checked })}
        />
        <strong>{mapping.label}</strong>
      </label>
      <select
        value={mapping.source}
        onChange={(event) => onChange({ ...mapping, source: event.target.value as CcSource })}
      >
        {CC_SOURCES.map((source) => (
          <option key={source.value} value={source.value}>
            {source.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        max={127}
        value={mapping.cc}
        onChange={(event) => onChange({ ...mapping, cc: Number(event.target.value) })}
      />
    </div>
  )
}

function CapturedNotesTable({ clip }: { clip: CapturedClip | null }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Note</th>
            <th>Start</th>
            <th>Duration</th>
            <th>Velocity</th>
            <th>Bends</th>
          </tr>
        </thead>
        <tbody>
          {clip && clip.cleanedNotes.length > 0 ? (
            clip.cleanedNotes.map((note) => (
              <tr key={note.id}>
                <td>{note.noteName}</td>
                <td>{note.start.toFixed(2)}s</td>
                <td>{note.duration.toFixed(2)}s</td>
                <td>{Math.round(note.velocity * 100)}%</td>
                <td>{note.pitchBends.length}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td className="empty-row" colSpan={5}>
                Capture a vocal performance to create a cleaned MIDI clip.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const width = Math.max(0, Math.min(100, (value / max) * 100))

  return (
    <div className="horizontal-meter">
      <span>{label}</span>
      <strong>{value.toFixed(3)}</strong>
      <i style={{ width: `${width}%` }} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function statusLabel(status: ControllerStatus): string {
  switch (status) {
    case 'capturing':
      return 'Capturing'
    case 'processing':
      return 'Cleaning capture'
    case 'calibrating':
      return 'Calibrating'
    case 'monitoring':
      return 'Live'
    case 'idle':
      return 'Idle'
  }
}

function calibrationFeedbackLabel(
  feedback: 'tooQuiet' | 'stableVoiceCaptured' | 'pitchRangeUnchanged',
): string {
  switch (feedback) {
    case 'tooQuiet':
      return 'Voice detected, but it is still quiet. Raise Input level if notes drop out.'
    case 'stableVoiceCaptured':
      return 'Stable voice captured.'
    case 'pitchRangeUnchanged':
      return 'Voice level captured. Pitch range unchanged.'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

function ringSegmentPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarPoint(cx, cy, outerRadius, startAngle)
  const outerEnd = polarPoint(cx, cy, outerRadius, endAngle)
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle)
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

function polarPoint(cx: number, cy: number, radius: number, angleDegrees: number) {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function stripOctave(note: string): string {
  return note.replace(/-?\d+$/, '')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
