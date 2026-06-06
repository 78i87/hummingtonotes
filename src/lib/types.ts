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
  noiseCleanup: number
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
  fit?: number
  ambiguous?: boolean
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

export type PitchBendMode = 'intellibend' | 'trubend'
export type ChordPreset =
  | 'majorTriad'
  | 'minorTriad'
  | 'powerFifth'
  | 'seventh'
  | 'diatonicTriad'
export type ChordVoicing = 'cluster' | 'spread'
export type CcSource = 'envelope' | 'ah' | 'ee' | 'oo'

export interface VocalCalibration {
  noiseFloorRms: number
  vocalRms: number
  rmsThreshold: number
  inputLevel: number
  minMidi: number
  maxMidi: number
  yinThreshold: number
}

export interface PitchControllerSettings {
  key: KeyName
  scale: ScaleName
  keyLock: boolean
  bendMode: PitchBendMode
  inputLevel: number
  stickiness: number
  transpose: number
  octave: number
}

export interface ChordControllerSettings {
  enabled: boolean
  preset: ChordPreset
  voicing: ChordVoicing
  holdSeconds: number
}

export interface TriggerFeature {
  attack: number
  rms: number
  peak: number
  brightness: number
  noisiness: number
}

export interface TriggerSlot {
  id: string
  label: string
  midi: number
  enabled: boolean
  examples: TriggerFeature[]
}

export interface CcMapping {
  id: string
  label: string
  source: CcSource
  cc: number
  enabled: boolean
}

export interface VocalProfile {
  id: string
  name: string
  updatedAt: number
  calibration: VocalCalibration
  pitch: PitchControllerSettings
  chords: ChordControllerSettings
  triggers: TriggerSlot[]
  ccMappings: CcMapping[]
  ccSmoothing: number
}

export interface LivePitchFrame {
  time: number
  rms: number
  estimatedMidi: number | null
  lockedMidi: number | null
  centsOffset: number
  confidence: number
  voiced: boolean
}

export interface NoteOnEvent {
  id: string
  type: 'noteOn'
  time: number
  midi: number
  velocity: number
}

export interface NoteOffEvent {
  id: string
  type: 'noteOff'
  time: number
  midi: number
}

export interface PitchBendEvent {
  id: string
  type: 'pitchBend'
  time: number
  midi: number
  value: number
}

export interface ChordEvent {
  id: string
  type: 'chord'
  time: number
  duration: number
  rootMidi: number
  notes: number[]
  velocity: number
}

export interface TriggerEvent {
  id: string
  type: 'trigger'
  time: number
  midi: number
  velocity: number
  slotId: string
}

export interface CcEvent {
  id: string
  type: 'cc'
  time: number
  cc: number
  value: number
}

export type PerformanceEvent =
  | NoteOnEvent
  | NoteOffEvent
  | PitchBendEvent
  | ChordEvent
  | TriggerEvent
  | CcEvent

export interface CapturedClip {
  duration: number
  rawFrames: LivePitchFrame[]
  rawEvents: PerformanceEvent[]
  cleanedEvents: PerformanceEvent[]
  cleanedNotes: AdjustedNote[]
  suggestedKey: KeySuggestion
}
