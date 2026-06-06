import { Note, Scale } from 'tonal'

import type { KeyName, ScaleName } from './types'

export const CHROMATIC_WHEEL_NOTES = [
  { label: 'C', chroma: 0 },
  { label: 'C#', chroma: 1 },
  { label: 'D', chroma: 2 },
  { label: 'D#', chroma: 3 },
  { label: 'E', chroma: 4 },
  { label: 'F', chroma: 5 },
  { label: 'F#', chroma: 6 },
  { label: 'G', chroma: 7 },
  { label: 'G#', chroma: 8 },
  { label: 'A', chroma: 9 },
  { label: 'A#', chroma: 10 },
  { label: 'B', chroma: 11 },
] as const

export function liveKeyWheelNotes(
  keyName: KeyName,
  scaleName: ScaleName,
  keyLock: boolean,
) {
  const scaleChromas = scalePitchClassSet(keyName, scaleName)

  return CHROMATIC_WHEEL_NOTES.map((note) => ({
    ...note,
    inKey: !keyLock || scaleChromas.has(note.chroma),
    visible: !keyLock || scaleChromas.has(note.chroma),
  }))
}

function scalePitchClassSet(keyName: KeyName, scaleName: ScaleName) {
  const notes = Scale.get(`${keyName} ${scaleName}`).notes
  const chromas = notes
    .map((note) => Note.get(note).chroma)
    .filter((chroma): chroma is number => chroma !== undefined)

  if (chromas.length === 0) {
    return new Set([Note.get(keyName).chroma ?? 0])
  }

  return new Set(chromas)
}
