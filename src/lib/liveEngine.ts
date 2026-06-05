import { closestScaleMidi, inferKey, midiToNoteName } from './music'
import type {
  CapturedClip,
  ChordPreset,
  ChordVoicing,
  CcEvent,
  AdjustedNote,
  KeyName,
  LivePitchFrame,
  PerformanceEvent,
  PitchBendMode,
  ScaleName,
  TriggerFeature,
  TriggerSlot,
  VocalCalibration,
  VocalProfile,
  DetectedNote,
} from './types'

export const LIVE_SAMPLE_RATE = 16_000
export const LIVE_FRAME_SIZE = 1024
export const LIVE_HOP_SIZE = 256
export const DEFAULT_YIN_THRESHOLD = 0.18
export const NOTE_SWITCH_SECONDS = 0.08
export const MIN_PITCH_HZ = 90
export const MAX_PITCH_HZ = 950
const MIN_RAW_NOTE_SECONDS = 0.04
const MIN_CLEAN_NOTE_SECONDS = 0.1
const WEAK_FRAGMENT_SECONDS = 0.16
const MAX_SAME_NOTE_GAP_SECONDS = 0.18
const MAX_WOBBLE_GAP_SECONDS = 0.14
const MAX_WOBBLE_SEMITONES = 1
const ISOLATED_JUMP_SEMITONES = 10
const MAX_PITCH_BENDS_PER_NOTE = 48

export interface PitchEstimate {
  frequency: number
  midi: number
  confidence: number
  yin: number
}

export interface LiveEngineState {
  activeMidi: number | null
  activeStartedAt: number
  pendingMidi: number | null
  pendingStartedAt: number
  lastFrameTime: number
  ccValues: Map<number, number>
}

export interface LiveFrameResult {
  frame: LivePitchFrame
  events: PerformanceEvent[]
  displayNote: string
  lockedMidi: number | null
}

export interface CaptureCleanupInput {
  frames: LivePitchFrame[]
  events: PerformanceEvent[]
  duration: number
  profile: VocalProfile
}

interface NoteCleanupOptions {
  profile?: VocalProfile
  applyPitchSettings?: boolean
  filterCalibrationRange?: boolean
}

export function createDefaultCalibration(): VocalCalibration {
  return {
    noiseFloorRms: 0.012,
    vocalRms: 0.12,
    rmsThreshold: 0.03,
    minMidi: 42,
    maxMidi: 84,
    yinThreshold: DEFAULT_YIN_THRESHOLD,
  }
}

export function createLiveEngineState(): LiveEngineState {
  return {
    activeMidi: null,
    activeStartedAt: 0,
    pendingMidi: null,
    pendingStartedAt: 0,
    lastFrameTime: 0,
    ccValues: new Map(),
  }
}

export function estimatePitchYin(
  samples: Float32Array,
  sampleRate: number,
  threshold = DEFAULT_YIN_THRESHOLD,
): PitchEstimate | null {
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ))
  const maxTau = Math.min(
    samples.length - 2,
    Math.ceil(sampleRate / MIN_PITCH_HZ),
  )
  if (maxTau <= minTau) {
    return null
  }

  const difference = new Float32Array(maxTau + 1)
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    let sum = 0
    for (let index = 0; index + tau < samples.length; index += 1) {
      const delta = samples[index] - samples[index + tau]
      sum += delta * delta
    }
    difference[tau] = sum
  }

  let runningTotal = 0
  const cumulative = new Float32Array(maxTau + 1)
  cumulative[0] = 1
  for (let tau = 1; tau <= maxTau; tau += 1) {
    runningTotal += difference[tau]
    cumulative[tau] = runningTotal > 0 ? (difference[tau] * tau) / runningTotal : 1
  }

  let bestTau = -1
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (cumulative[tau] < threshold) {
      bestTau = tau
      while (bestTau + 1 <= maxTau && cumulative[bestTau + 1] < cumulative[bestTau]) {
        bestTau += 1
      }
      break
    }
  }

  if (bestTau < 0) {
    let bestValue = Number.POSITIVE_INFINITY
    for (let tau = minTau; tau <= maxTau; tau += 1) {
      if (cumulative[tau] < bestValue) {
        bestValue = cumulative[tau]
        bestTau = tau
      }
    }
    if (bestValue > threshold * 1.35) {
      return null
    }
  }

  const refinedTau = parabolicTau(cumulative, bestTau)
  const frequency = sampleRate / refinedTau
  const midi = frequencyToMidi(frequency)
  if (!Number.isFinite(midi)) {
    return null
  }

  const yin = cumulative[bestTau]
  return {
    frequency,
    midi,
    yin,
    confidence: Math.max(0, Math.min(1, 1 - yin)),
  }
}

export function analyzeLiveFrame(
  samples: Float32Array,
  sampleRate: number,
  time: number,
  profile: VocalProfile,
  state: LiveEngineState,
): LiveFrameResult {
  const filtered = bandLimit(samples, sampleRate)
  const rmsValue = rms(filtered)
  const estimate =
    rmsValue >= profile.calibration.rmsThreshold
      ? estimatePitchYin(
          filtered,
          sampleRate,
          profile.calibration.yinThreshold,
        )
      : null
  const inRange =
    estimate &&
    estimate.midi >= profile.calibration.minMidi &&
    estimate.midi <= profile.calibration.maxMidi
  const voiced = Boolean(inRange)
  const estimatedMidi = inRange ? estimate.midi : null
  const lockedMidi =
    estimatedMidi === null
      ? null
      : outputMidiForPitch(
          estimatedMidi,
          profile.pitch.key,
          profile.pitch.scale,
          profile.pitch.keyLock,
          profile.pitch.transpose + profile.pitch.octave * 12,
        )
  const centsOffset =
    estimatedMidi === null || lockedMidi === null
      ? 0
      : (estimatedMidi + profile.pitch.transpose + profile.pitch.octave * 12 - lockedMidi) * 100
  const frame: LivePitchFrame = {
    time,
    rms: rmsValue,
    estimatedMidi,
    lockedMidi,
    centsOffset,
    confidence: estimate?.confidence ?? 0,
    voiced,
  }

  const events = noteEventsForFrame(
    frame,
    profile.pitch.bendMode,
    state,
    profile.pitch.stickiness,
  )
  events.push(...ccEventsForFrame(frame, samples, profile, state))
  state.lastFrameTime = time

  return {
    frame,
    events,
    lockedMidi,
    displayNote: lockedMidi === null ? '...' : midiToNoteName(lockedMidi),
  }
}

export function noteEventsForFrame(
  frame: LivePitchFrame,
  bendMode: PitchBendMode,
  state: LiveEngineState,
  stickiness = 0.5,
): PerformanceEvent[] {
  const events: PerformanceEvent[] = []
  const safeStickiness = Math.max(0, Math.min(1, stickiness))
  if (!frame.voiced || frame.lockedMidi === null) {
    if (state.activeMidi !== null) {
      events.push({
        id: `note-off-${frame.time}`,
        type: 'noteOff',
        time: frame.time,
        midi: state.activeMidi,
      })
      state.activeMidi = null
      state.pendingMidi = null
    }
    return events
  }

  const targetMidi = frame.lockedMidi

  if (state.activeMidi === null) {
    state.activeMidi = targetMidi
    state.activeStartedAt = frame.time
    events.push({
      id: `note-on-${frame.time}`,
      type: 'noteOn',
      time: frame.time,
      midi: targetMidi,
      velocity: velocityFromRms(frame.rms),
    })
  } else if (targetMidi !== state.activeMidi) {
    if (bendMode === 'intellibend') {
      if (!pitchMovedFarEnoughToSwitch(frame, state.activeMidi, targetMidi, safeStickiness)) {
        state.pendingMidi = null
      } else if (state.pendingMidi !== targetMidi) {
        state.pendingMidi = targetMidi
        state.pendingStartedAt = frame.time
      } else if (frame.time - state.pendingStartedAt >= switchDelayForStickiness(safeStickiness)) {
        events.push({
          id: `note-off-${frame.time}`,
          type: 'noteOff',
          time: frame.time,
          midi: state.activeMidi,
        })
        events.push({
          id: `note-on-${frame.time}`,
          type: 'noteOn',
          time: frame.time,
          midi: targetMidi,
          velocity: velocityFromRms(frame.rms),
        })
        state.activeMidi = targetMidi
        state.activeStartedAt = frame.time
        state.pendingMidi = null
      }
    } else {
      events.push({
        id: `note-off-${frame.time}`,
        type: 'noteOff',
        time: frame.time,
        midi: state.activeMidi,
      })
      events.push({
        id: `note-on-${frame.time}`,
        type: 'noteOn',
        time: frame.time,
        midi: targetMidi,
        velocity: velocityFromRms(frame.rms),
      })
      state.activeMidi = targetMidi
      state.activeStartedAt = frame.time
    }
  } else {
    state.pendingMidi = null
  }

  if (state.activeMidi !== null) {
    events.push({
      id: `bend-${frame.time}`,
      type: 'pitchBend',
      time: frame.time,
      midi: state.activeMidi,
      value: pitchBendFromCents(frame.centsOffset),
    })
  }

  return events
}

export function chordNotesForRoot(
  rootMidi: number,
  preset: ChordPreset,
  voicing: ChordVoicing,
  key: KeyName,
  scale: ScaleName,
): number[] {
  let intervals: number[]
  if (preset === 'minorTriad') {
    intervals = [0, 3, 7]
  } else if (preset === 'powerFifth') {
    intervals = [0, 7, 12]
  } else if (preset === 'seventh') {
    intervals = [0, 4, 7, 10]
  } else if (preset === 'diatonicTriad') {
    intervals = diatonicTriadIntervals(rootMidi, key, scale)
  } else {
    intervals = [0, 4, 7]
  }

  const notes = intervals.map((interval) => rootMidi + interval)
  if (voicing === 'spread') {
    return notes.map((note, index) => note + (index >= 2 ? 12 : 0))
  }

  return notes.map((note) => {
    let compact = note
    while (compact - rootMidi > 12) {
      compact -= 12
    }
    return compact
  })
}

export function createChordEvents(
  rootMidi: number,
  time: number,
  duration: number,
  profile: VocalProfile,
): PerformanceEvent[] {
  const chordNotes = chordNotesForRoot(
    rootMidi,
    profile.chords.preset,
    profile.chords.voicing,
    profile.pitch.key,
    profile.pitch.scale,
  )

  return [
    {
      id: `chord-${time}`,
      type: 'chord',
      time,
      duration,
      rootMidi,
      notes: chordNotes,
      velocity: 0.82,
    },
  ]
}

export function extractTriggerFeature(samples: Float32Array): TriggerFeature {
  const length = Math.max(1, samples.length)
  const attackLength = Math.max(1, Math.floor(length * 0.2))
  let peak = 0
  let sum = 0
  let attackSum = 0
  let highBand = 0
  let zeroCrossings = 0

  for (let index = 0; index < length; index += 1) {
    const value = samples[index]
    const abs = Math.abs(value)
    peak = Math.max(peak, abs)
    sum += value * value
    if (index < attackLength) {
      attackSum += value * value
    }
    if (index > 0 && Math.sign(value) !== Math.sign(samples[index - 1])) {
      zeroCrossings += 1
    }
    highBand += Math.abs(value - (samples[index - 1] ?? 0))
  }

  return normalizeTriggerFeature({
    attack: Math.sqrt(attackSum / attackLength),
    rms: Math.sqrt(sum / length),
    peak,
    brightness: highBand / length,
    noisiness: zeroCrossings / length,
  })
}

export function classifyTrigger(
  feature: TriggerFeature,
  slots: TriggerSlot[],
): TriggerSlot | null {
  let bestSlot: TriggerSlot | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  slots.forEach((slot) => {
    if (!slot.enabled || slot.examples.length === 0) {
      return
    }

    const distance =
      slot.examples.reduce(
        (sum, example) => sum + triggerDistance(feature, example),
        0,
      ) / slot.examples.length
    if (distance < bestDistance) {
      bestDistance = distance
      bestSlot = slot
    }
  })

  return bestDistance <= 0.32 ? bestSlot : null
}

export function cleanupCapturedClip(input: CaptureCleanupInput): CapturedClip {
  const notes = eventsToCapturedNotes(input.events)
  const cleanedNotes = cleanupPitchNotes(notes)
  const cleanedEvents = notesToEvents(cleanedNotes)
  const suggestedKey = inferKeyFromFrames(input.frames, input.profile)

  return {
    duration: input.duration,
    rawFrames: input.frames,
    rawEvents: input.events,
    cleanedEvents,
    cleanedNotes,
    suggestedKey,
  }
}

export function mergeClipWithBasicPitch(
  clip: CapturedClip,
  basicPitchNotes: DetectedNote[],
  profile?: VocalProfile,
): CapturedClip {
  if (basicPitchNotes.length === 0) {
    return clip
  }

  const basicNotes = cleanupPitchNotes(
    basicPitchNotes
    .filter((note) => note.duration >= 0.05 && note.confidence >= 0.12)
    .map((note, index) => {
      const roundedMidi = Math.round(note.midi)
      return {
        id: `basic-${index}`,
        rawId: note.id,
        start: note.start,
        duration: note.duration,
        quantizedStart: note.start,
        quantizedDuration: note.duration,
        rawMidi: roundedMidi,
        midi: roundedMidi,
        rawNoteName: midiToNoteName(roundedMidi),
        noteName: midiToNoteName(roundedMidi),
        velocity: Math.max(0.1, Math.min(1, note.velocity)),
        pitchBends: note.pitchBends,
        confidence: note.confidence,
      }
    }),
    {
      profile,
      applyPitchSettings: Boolean(profile),
      filterCalibrationRange: Boolean(profile),
    },
  )

  if (basicNotes.length === 0) {
    return clip
  }

  const liveNotes = cleanupPitchNotes(clip.cleanedNotes)
  const liveCoverage = totalNoteSeconds(liveNotes)
  const basicCoverage = totalNoteSeconds(basicNotes)
  const liveAverageDuration = averageNoteDuration(liveNotes)
  const basicAverageDuration = averageNoteDuration(basicNotes)
  const basicTooSparse =
    liveCoverage > 0.1 && basicCoverage < liveCoverage * 0.45
  const basicTooFragmented =
    liveNotes.length > 0 &&
    basicNotes.length > Math.max(liveNotes.length * 2.4, liveNotes.length + 8) &&
    basicAverageDuration < liveAverageDuration * 0.6
  const useBasic =
    liveNotes.length === 0 ||
    (!basicTooSparse && !basicTooFragmented && basicCoverage >= Math.max(0.1, liveCoverage * 0.55))
  const cleanedNotes = useBasic ? basicNotes : liveNotes

  return {
    ...clip,
    cleanedNotes,
    cleanedEvents: notesToEvents(cleanedNotes),
    suggestedKey: inferKey(
      cleanedNotes.map((note) => ({
        id: note.id,
        start: note.start,
        duration: note.duration,
        midi: note.midi,
        velocity: note.velocity,
        pitchBends: note.pitchBends,
        confidence: note.confidence,
      })),
    ),
  }
}

export function eventsToCapturedNotes(events: PerformanceEvent[]): AdjustedNote[] {
  const active = new Map<number, PerformanceEvent>()
  const notes: AdjustedNote[] = []

  events
    .slice()
    .sort((a, b) => a.time - b.time)
    .forEach((event) => {
      if (event.type === 'noteOn') {
        active.set(event.midi, event)
      } else if (event.type === 'noteOff') {
        const start = active.get(event.midi)
        if (start && start.type === 'noteOn') {
          notes.push({
            id: `captured-${notes.length}`,
            rawId: start.id,
            start: start.time,
            duration: Math.max(0.02, event.time - start.time),
            quantizedStart: start.time,
            quantizedDuration: Math.max(0.02, event.time - start.time),
            rawMidi: event.midi,
            midi: event.midi,
            rawNoteName: midiToNoteName(event.midi),
            noteName: midiToNoteName(event.midi),
            velocity: start.velocity,
            pitchBends: pitchBendsForNote(events, event.midi, start.time, event.time),
            confidence: 0.85,
          })
        }
        active.delete(event.midi)
      }
    })

  return notes
}

export function cleanupPitchNotes(
  notes: AdjustedNote[],
  options: NoteCleanupOptions = {},
): AdjustedNote[] {
  const normalized = notes
    .map((note) => normalizeNoteForCleanup(note, options))
    .filter((note) => note.duration >= MIN_RAW_NOTE_SECONDS)
    .filter((note) => note.confidence >= 0.08 || note.velocity >= 0.18)
    .filter((note) => isWithinCalibrationRange(note, options))

  const withoutJumps = removeIsolatedPitchJumps(normalized)
  const merged = mergePhraseFragments(withoutJumps)
  const mono = monophonizeNotes(merged)
  const finalNotes = mergePhraseFragments(removeWeakResidualNotes(mono))

  return finalNotes.map((note, index) => ({
    ...note,
    id: note.id || `clean-${index}`,
    quantizedStart: note.start,
    quantizedDuration: note.duration,
    rawNoteName: midiToNoteName(note.rawMidi),
    noteName: midiToNoteName(note.midi),
    pitchBends: samplePitchBends(note.pitchBends, MAX_PITCH_BENDS_PER_NOTE),
  }))
}

function notesToEvents(notes: AdjustedNote[]): PerformanceEvent[] {
  return notes.flatMap((note) => [
    {
      id: `${note.id}-on`,
      type: 'noteOn' as const,
      time: note.start,
      midi: note.midi,
      velocity: note.velocity,
    },
    {
      id: `${note.id}-off`,
      type: 'noteOff' as const,
      time: note.start + note.duration,
      midi: note.midi,
    },
    ...note.pitchBends.map((value: number, index: number) => ({
      id: `${note.id}-bend-${index}`,
      type: 'pitchBend' as const,
      time: note.start + (note.duration * index) / Math.max(1, note.pitchBends.length),
      midi: note.midi,
      value,
    })),
  ])
}

function outputMidiForPitch(
  midi: number,
  key: KeyName,
  scale: ScaleName,
  keyLock: boolean,
  transpose: number,
): number {
  const transposed = midi + transpose
  return keyLock
    ? closestScaleMidi(Math.round(transposed), key, scale)
    : Math.round(transposed)
}

function ccEventsForFrame(
  frame: LivePitchFrame,
  samples: Float32Array,
  profile: VocalProfile,
  state: LiveEngineState,
): CcEvent[] {
  const envelopeValue = Math.max(
    0,
    Math.min(127, Math.round((frame.rms / profile.calibration.vocalRms) * 96)),
  )
  const vowel = vowelFromSpectrum(samples)
  const events: CcEvent[] = []

  profile.ccMappings.forEach((mapping) => {
    if (!mapping.enabled) {
      return
    }

    if (mapping.source === 'envelope') {
      events.push({
        id: `cc-${mapping.cc}-${frame.time}`,
        type: 'cc',
        time: frame.time,
        cc: mapping.cc,
        value: envelopeValue,
      })
    } else {
      const sourceValue = vowel[mapping.source]
      events.push({
        id: `cc-${mapping.cc}-${frame.time}`,
        type: 'cc',
        time: frame.time,
        cc: mapping.cc,
        value: Math.max(0, Math.min(127, Math.round(sourceValue * 127))),
      })
    }
  })

  return smoothCcEvents(events, profile.ccSmoothing, state.ccValues)
}

export function smoothCcEvents(
  events: CcEvent[],
  smoothing: number,
  previous = new Map<number, number>(),
): CcEvent[] {
  const safeSmoothing = Math.max(0, Math.min(0.95, smoothing))

  return events.map((event) => {
    const before = previous.get(event.cc) ?? event.value
    const value = Math.round(before * safeSmoothing + event.value * (1 - safeSmoothing))
    previous.set(event.cc, value)
    return { ...event, value }
  })
}

function vowelFromSpectrum(samples: Float32Array) {
  let low = 0
  let mid = 0
  let high = 0
  for (let index = 1; index < samples.length; index += 1) {
    const delta = Math.abs(samples[index] - samples[index - 1])
    const abs = Math.abs(samples[index])
    low += abs
    mid += Math.abs(samples[index] - samples[Math.max(0, index - 4)])
    high += delta
  }
  const total = Math.max(0.0001, low + mid + high)
  return {
    ah: low / total,
    oo: mid / total,
    ee: high / total,
  }
}

function inferKeyFromFrames(frames: LivePitchFrame[], profile: VocalProfile) {
  const voiced = frames
    .filter((frame) => frame.lockedMidi !== null)
    .map((frame, index) => ({
      id: `frame-${index}`,
      start: frame.time,
      duration: LIVE_HOP_SIZE / LIVE_SAMPLE_RATE,
      midi: frame.lockedMidi ?? 60,
      velocity: velocityFromRms(frame.rms),
      pitchBends: [],
      confidence: frame.confidence,
    }))

  if (voiced.length === 0) {
    return {
      key: profile.pitch.key,
      scale: profile.pitch.scale,
      confidence: 0,
      ambiguous: true,
    }
  }

  const byPitch = new Map<number, typeof voiced[number]>()
  voiced.forEach((note) => {
    const key = Math.round(note.midi)
    const current = byPitch.get(key)
    if (!current || note.confidence > current.confidence) {
      byPitch.set(key, note)
    }
  })

  return inferKey([...byPitch.values()])
}

function pitchBendsForNote(
  events: PerformanceEvent[],
  midi: number,
  start: number,
  end: number,
): number[] {
  return events
    .flatMap((event) =>
      event.type === 'pitchBend' &&
      event.midi === midi &&
      event.time >= start &&
      event.time <= end
        ? [event.value]
        : [],
    )
}

function normalizeNoteForCleanup(
  note: AdjustedNote,
  options: NoteCleanupOptions,
): AdjustedNote {
  const rawMidi = Math.round(note.rawMidi)
  const profile = options.profile
  const midi =
    options.applyPitchSettings && profile
      ? outputMidiForPitch(
          note.midi,
          profile.pitch.key,
          profile.pitch.scale,
          profile.pitch.keyLock,
          profile.pitch.transpose + profile.pitch.octave * 12,
        )
      : Math.round(note.midi)

  return {
    ...note,
    duration: Math.max(0, note.duration),
    quantizedStart: note.start,
    quantizedDuration: Math.max(0, note.duration),
    rawMidi,
    midi,
    rawNoteName: midiToNoteName(rawMidi),
    noteName: midiToNoteName(midi),
    velocity: Math.max(0.1, Math.min(1, note.velocity)),
    confidence: Math.max(0, Math.min(1, note.confidence)),
    pitchBends: samplePitchBends(note.pitchBends, MAX_PITCH_BENDS_PER_NOTE),
  }
}

function isWithinCalibrationRange(
  note: AdjustedNote,
  options: NoteCleanupOptions,
): boolean {
  if (!options.filterCalibrationRange || !options.profile) {
    return true
  }

  const lower = options.profile.calibration.minMidi - 8
  const upper = options.profile.calibration.maxMidi + 4
  return note.rawMidi >= lower && note.rawMidi <= upper
}

function removeIsolatedPitchJumps(notes: AdjustedNote[]): AdjustedNote[] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start)

  return sorted.filter((note, index) => {
    const previous = sorted[index - 1]
    const next = sorted[index + 1]
    if (!previous || !next) {
      return true
    }

    const previousEnd = previous.start + previous.duration
    const noteEnd = note.start + note.duration
    const nearbyPrevious = note.start - previousEnd <= 0.24
    const nearbyNext = next.start - noteEnd <= 0.24
    const neighborsAgree = Math.abs(previous.midi - next.midi) <= 4
    const jumpsAway =
      Math.abs(note.midi - previous.midi) >= ISOLATED_JUMP_SEMITONES &&
      Math.abs(note.midi - next.midi) >= ISOLATED_JUMP_SEMITONES
    const shortOrWeak =
      note.duration <= 0.22 || note.confidence < 0.62 || note.velocity < 0.45

    return !(
      nearbyPrevious &&
      nearbyNext &&
      neighborsAgree &&
      jumpsAway &&
      shortOrWeak
    )
  })
}

function mergePhraseFragments(notes: AdjustedNote[]): AdjustedNote[] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start)
  const merged: AdjustedNote[] = []

  sorted.forEach((note) => {
    const previous = merged[merged.length - 1]
    if (previous && shouldMergeFragments(previous, note)) {
      merged[merged.length - 1] = mergeAdjustedNotes(previous, note)
      return
    }

    merged.push({ ...note, pitchBends: [...note.pitchBends] })
  })

  return merged
}

function shouldMergeFragments(previous: AdjustedNote, note: AdjustedNote): boolean {
  const previousEnd = previous.start + previous.duration
  const gap = note.start - previousEnd
  const distance = Math.abs(note.midi - previous.midi)

  if (distance === 0) {
    return gap <= MAX_SAME_NOTE_GAP_SECONDS
  }

  if (distance > MAX_WOBBLE_SEMITONES || gap > MAX_WOBBLE_GAP_SECONDS) {
    return false
  }

  return (
    previous.duration <= WEAK_FRAGMENT_SECONDS ||
    note.duration <= WEAK_FRAGMENT_SECONDS ||
    previous.confidence < 0.65 ||
    note.confidence < 0.65
  )
}

function mergeAdjustedNotes(first: AdjustedNote, second: AdjustedNote): AdjustedNote {
  const start = Math.min(first.start, second.start)
  const end = Math.max(first.start + first.duration, second.start + second.duration)
  const firstWeight = noteWeight(first)
  const secondWeight = noteWeight(second)
  const totalWeight = Math.max(0.0001, firstWeight + secondWeight)
  const rawMidi = Math.round(
    (first.rawMidi * firstWeight + second.rawMidi * secondWeight) / totalWeight,
  )
  const midi = Math.round(
    (first.midi * firstWeight + second.midi * secondWeight) / totalWeight,
  )

  return {
    ...first,
    rawId: `${first.rawId}+${second.rawId}`,
    start,
    duration: end - start,
    quantizedStart: start,
    quantizedDuration: end - start,
    rawMidi,
    midi,
    rawNoteName: midiToNoteName(rawMidi),
    noteName: midiToNoteName(midi),
    velocity: Math.max(first.velocity, second.velocity),
    confidence: Math.max(first.confidence, second.confidence),
    pitchBends: samplePitchBends(
      [...first.pitchBends, ...second.pitchBends],
      MAX_PITCH_BENDS_PER_NOTE,
    ),
  }
}

function removeWeakResidualNotes(notes: AdjustedNote[]): AdjustedNote[] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start)

  return sorted.filter((note, index) => {
    if (note.duration >= MIN_CLEAN_NOTE_SECONDS) {
      return true
    }

    const previous = sorted[index - 1]
    const next = sorted[index + 1]
    const previousEnd = previous ? previous.start + previous.duration : 0
    const noteEnd = note.start + note.duration
    const hasNearbyNeighbor =
      Boolean(previous && note.start - previousEnd <= MAX_SAME_NOTE_GAP_SECONDS) ||
      Boolean(next && next.start - noteEnd <= MAX_SAME_NOTE_GAP_SECONDS)
    const isWeak = note.confidence < 0.55 || note.velocity < 0.35

    return !(hasNearbyNeighbor && (note.duration < 0.08 || isWeak))
  })
}

function noteWeight(note: AdjustedNote): number {
  return Math.max(0.05, note.duration) * Math.max(0.1, note.velocity) * Math.max(0.2, note.confidence)
}

function samplePitchBends(values: number[], limit: number): number[] {
  if (values.length <= limit) {
    return [...values]
  }

  if (limit <= 1) {
    return values.length > 0 ? [values[0] ?? 0] : []
  }

  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round(((values.length - 1) * index) / (limit - 1))
    return values[sourceIndex] ?? 0
  })
}

function totalNoteSeconds(notes: AdjustedNote[]): number {
  return notes.reduce((sum, note) => sum + Math.max(0, note.duration), 0)
}

function averageNoteDuration(notes: AdjustedNote[]): number {
  if (notes.length === 0) {
    return 0
  }

  return totalNoteSeconds(notes) / notes.length
}

function monophonizeNotes(notes: AdjustedNote[]): AdjustedNote[] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start)
  const mono: AdjustedNote[] = []

  sorted.forEach((note) => {
    const previous = mono[mono.length - 1]
    if (!previous) {
      mono.push({ ...note, pitchBends: [...note.pitchBends] })
      return
    }

    const previousEnd = previous.start + previous.duration
    if (note.start >= previousEnd) {
      mono.push({ ...note, pitchBends: [...note.pitchBends] })
      return
    }

    const previousScore = previous.confidence * previous.velocity * previous.duration
    const nextScore = note.confidence * note.velocity * note.duration
    if (nextScore > previousScore) {
      const trimmedPreviousDuration = Math.max(0, note.start - previous.start)
      if (trimmedPreviousDuration >= 0.05) {
        previous.duration = trimmedPreviousDuration
        previous.quantizedDuration = trimmedPreviousDuration
        mono.push({ ...note, pitchBends: [...note.pitchBends] })
      } else {
        mono[mono.length - 1] = { ...note, pitchBends: [...note.pitchBends] }
      }
    } else {
      const noteEnd = note.start + note.duration
      if (noteEnd > previousEnd + 0.05) {
        mono.push({
          ...note,
          start: previousEnd,
          quantizedStart: previousEnd,
          duration: noteEnd - previousEnd,
          quantizedDuration: noteEnd - previousEnd,
          pitchBends: [...note.pitchBends],
        })
      }
    }
  })

  return mono
}

function diatonicTriadIntervals(rootMidi: number, key: KeyName, scale: ScaleName) {
  const third = closestScaleMidi(rootMidi + 4, key, scale) - rootMidi
  const fifth = closestScaleMidi(rootMidi + 7, key, scale) - rootMidi
  return [0, third, fifth]
}

function triggerDistance(first: TriggerFeature, second: TriggerFeature): number {
  return (
    Math.abs(first.attack - second.attack) +
    Math.abs(first.rms - second.rms) +
    Math.abs(first.peak - second.peak) +
    Math.abs(first.brightness - second.brightness) +
    Math.abs(first.noisiness - second.noisiness)
  ) / 5
}

function normalizeTriggerFeature(feature: TriggerFeature): TriggerFeature {
  const max = Math.max(
    0.0001,
    feature.attack,
    feature.rms,
    feature.peak,
    feature.brightness,
    feature.noisiness,
  )
  return {
    attack: feature.attack / max,
    rms: feature.rms / max,
    peak: feature.peak / max,
    brightness: feature.brightness / max,
    noisiness: feature.noisiness / max,
  }
}

function bandLimit(samples: Float32Array, sampleRate: number): Float32Array {
  const highPassed = applyOnePoleHighPass(samples, sampleRate, 80)
  return applyOnePoleLowPass(highPassed, sampleRate, 1200)
}

function applyOnePoleLowPass(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
) {
  const output = new Float32Array(samples.length)
  const alpha = 1 - Math.exp((-2 * Math.PI * frequency) / sampleRate)
  let state = 0
  for (let index = 0; index < samples.length; index += 1) {
    state += alpha * (samples[index] - state)
    output[index] = state
  }
  return output
}

function applyOnePoleHighPass(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
) {
  const low = applyOnePoleLowPass(samples, sampleRate, frequency)
  const output = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = samples[index] - low[index]
  }
  return output
}

function parabolicTau(values: Float32Array, tau: number): number {
  if (tau <= 0 || tau >= values.length - 1) {
    return tau
  }
  const left = values[tau - 1]
  const center = values[tau]
  const right = values[tau + 1]
  const denominator = left - 2 * center + right
  if (Math.abs(denominator) < 1e-9) {
    return tau
  }
  return tau + (left - right) / (2 * denominator)
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index]
  }
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function frequencyToMidi(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440)
}

function velocityFromRms(value: number): number {
  return Math.max(0.1, Math.min(1, value * 8))
}

function pitchBendFromCents(cents: number): number {
  return Math.max(-1, Math.min(1, cents / 200))
}

function switchDelayForStickiness(stickiness: number): number {
  return NOTE_SWITCH_SECONDS - 0.035 + stickiness * 0.07
}

function pitchMovedFarEnoughToSwitch(
  frame: LivePitchFrame,
  activeMidi: number,
  targetMidi: number,
  stickiness: number,
): boolean {
  const estimatedOutputMidi =
    frame.lockedMidi === null ? targetMidi : frame.lockedMidi + frame.centsOffset / 100
  const distance = Math.abs(estimatedOutputMidi - activeMidi)
  const requiredDistance = 0.48 + stickiness * 0.38

  return distance >= requiredDistance
}
