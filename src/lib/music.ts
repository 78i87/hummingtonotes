import { Note, Scale } from 'tonal'

import type {
  AdjustedNote,
  AnalysisSettings,
  DetectedNote,
  KeyName,
  KeySuggestion,
  ManualNoteEdit,
  ScaleName,
} from './types'
import { KEYS } from './types'

const DEFAULT_KEY: KeySuggestion = {
  key: 'C',
  scale: 'major',
  confidence: 0,
  fit: 0,
  ambiguous: true,
}
const SHARP_NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
]

export function midiToNoteName(midi: number): string {
  const roundedMidi = Math.round(midi)
  const pitchClass = positiveModulo(roundedMidi, 12)
  const octave = Math.floor(roundedMidi / 12) - 1
  return `${SHARP_NOTE_NAMES[pitchClass]}${octave}`
}

export function inferKey(notes: DetectedNote[]): KeySuggestion {
  if (notes.length === 0) {
    return DEFAULT_KEY
  }

  const candidates = KEYS.flatMap((key) => [
    scoreKey(notes, key, 'major'),
    scoreKey(notes, key, 'minor'),
  ]).sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const next = candidates[1]
  if (!best) {
    return DEFAULT_KEY
  }

  const totalWeight = notes.reduce(
    (sum, note) => sum + Math.max(0.05, note.duration) * note.velocity,
    0,
  )
  const confidence =
    totalWeight > 0 && next
      ? Math.max(0, Math.min(1, (best.score - next.score) / totalWeight))
      : 0

  return {
    key: best.key,
    scale: best.scale,
    confidence,
    fit: best.fit,
    ambiguous: confidence < 0.08,
  }
}

export function adjustNotes(
  rawNotes: DetectedNote[],
  settings: AnalysisSettings,
  manualEdits: Record<string, ManualNoteEdit> = {},
): AdjustedNote[] {
  if (rawNotes.length === 0) {
    return []
  }

  const baseRawMidi = Math.round(rawNotes[0].midi)
  const baseTargetMidi = closestScaleMidi(
    baseRawMidi + settings.transpose,
    settings.key,
    settings.scale,
  )

  return rawNotes.map((note) => {
    const rawRoundedMidi = Math.round(note.midi)
    const rawWithTranspose = rawRoundedMidi + settings.transpose
    const relativeMidi = baseTargetMidi + (rawRoundedMidi - baseRawMidi)
    const snappedMidi = closestScaleMidi(
      relativeMidi,
      settings.key,
      settings.scale,
    )
    const correctedMidi = Math.round(
      lerp(rawWithTranspose, snappedMidi, settings.correctionStrength),
    )
    const quantizedStart = quantizeSeconds(
      note.start,
      settings.tempo,
      settings.grid,
      settings.quantizeStrength,
    )
    const quantizedDuration = Math.max(
      gridSeconds(settings.tempo, settings.grid) / 2,
      quantizeSeconds(
        note.duration,
        settings.tempo,
        settings.grid,
        settings.quantizeStrength,
      ),
    )
    const edit = manualEdits[note.id]
    const midi = edit?.midi ?? correctedMidi

    return {
      id: note.id,
      rawId: note.id,
      start: note.start,
      duration: note.duration,
      quantizedStart: edit?.quantizedStart ?? quantizedStart,
      quantizedDuration: edit?.quantizedDuration ?? quantizedDuration,
      rawMidi: rawRoundedMidi,
      midi,
      rawNoteName: midiToNoteName(rawRoundedMidi),
      noteName: midiToNoteName(midi),
      velocity: clamp(note.velocity, 0.1, 1),
      pitchBends: note.pitchBends,
      confidence: note.confidence,
    }
  })
}

export function closestScaleMidi(
  midi: number,
  key: KeyName,
  scale: ScaleName,
): number {
  const pitchClasses = scalePitchClasses(key, scale)
  if (pitchClasses.length === 0) {
    return Math.round(midi)
  }

  let bestMidi = Math.round(midi)
  let bestDistance = Number.POSITIVE_INFINITY

  for (
    let candidate = Math.floor(midi) - 12;
    candidate <= Math.ceil(midi) + 12;
    candidate += 1
  ) {
    const pitchClass = positiveModulo(candidate, 12)
    if (!pitchClasses.includes(pitchClass)) {
      continue
    }

    const distance = Math.abs(candidate - midi)
    if (distance < bestDistance) {
      bestDistance = distance
      bestMidi = candidate
    }
  }

  return bestMidi
}

export function quantizeSeconds(
  seconds: number,
  tempo: number,
  grid: number,
  strength: number,
): number {
  const step = gridSeconds(tempo, grid)
  if (step <= 0) {
    return seconds
  }

  const snapped = Math.round(seconds / step) * step
  return Math.max(0, lerp(seconds, snapped, strength))
}

export function gridSeconds(tempo: number, grid: number): number {
  return (60 / Math.max(1, tempo)) * grid
}

export function defaultSettings(suggestion: KeySuggestion): AnalysisSettings {
  return {
    key: suggestion.key,
    scale: suggestion.scale,
    transpose: 0,
    noiseCleanup: 0.7,
    articulationCleanup: 0.7,
    correctionStrength: 0.85,
    tempo: 100,
    grid: 0.25,
    quantizeStrength: 0.75,
    exportPitchBends: false,
  }
}

function scoreKey(
  notes: DetectedNote[],
  key: KeyName,
  scale: ScaleName,
): KeySuggestion & { fit: number; score: number } {
  const pitchClasses = scalePitchClasses(key, scale)
  let fitWeight = 0
  let totalWeight = 0
  const score = notes.reduce((sum, note, index) => {
    const pitchClass = positiveModulo(Math.round(note.midi), 12)
    const weight =
      Math.max(0.05, note.duration) *
      clamp(note.velocity, 0.1, 1) *
      (index === 0 || index === notes.length - 1 ? 1.4 : 1)
    const isInScale = pitchClasses.includes(pitchClass)

    totalWeight += weight
    if (isInScale) {
      fitWeight += weight
    }

    return sum + (isInScale ? weight : -weight * 0.25)
  }, 0)

  return {
    key,
    scale,
    confidence: 0,
    fit: totalWeight > 0 ? fitWeight / totalWeight : 0,
    score,
  }
}

function scalePitchClasses(key: KeyName, scale: ScaleName): number[] {
  const tonalScale = Scale.get(`${key} ${scale}`)
  return tonalScale.notes
    .map((note) => Note.get(note).chroma)
    .filter((chroma): chroma is number => typeof chroma === 'number')
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo
}

function lerp(from: number, to: number, strength: number): number {
  const safeStrength = clamp(strength, 0, 1)
  return from + (to - from) * safeStrength
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
