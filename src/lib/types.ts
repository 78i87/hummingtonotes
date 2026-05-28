export const KEYS = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
] as const

export const SCALES = [
  'major',
  'minor',
  'major pentatonic',
  'minor pentatonic',
] as const

export type KeyName = (typeof KEYS)[number]
export type ScaleName = (typeof SCALES)[number]

export interface DetectedNote {
  id: string
  start: number
  duration: number
  midi: number
  velocity: number
  pitchBends: number[]
  confidence: number
}

export interface RawTranscription {
  frames: number[][]
  onsets: number[][]
  contours: number[][]
  notes: DetectedNote[]
  duration: number
}

export interface AdjustedNote {
  id: string
  rawId: string
  start: number
  duration: number
  quantizedStart: number
  quantizedDuration: number
  rawMidi: number
  midi: number
  rawNoteName: string
  noteName: string
  velocity: number
  pitchBends: number[]
  confidence: number
}

export interface AnalysisSettings {
  key: KeyName
  scale: ScaleName
  transpose: number
  articulationCleanup: number
  correctionStrength: number
  tempo: number
  grid: number
  quantizeStrength: number
  exportPitchBends: boolean
}

export interface KeySuggestion {
  key: KeyName
  scale: ScaleName
  confidence: number
}

export interface AnalysisResult {
  raw: RawTranscription
  adjustedNotes: AdjustedNote[]
  suggestedKey: KeySuggestion
}

export interface ManualNoteEdit {
  midi?: number
  quantizedStart?: number
  quantizedDuration?: number
}
