import { describe, expect, it } from 'vitest'

import { liveKeyWheelNotes } from './keyWheel'

describe('live key wheel', () => {
  it('shows only D minor notes when key lock is on', () => {
    expect(visibleLabels('D', 'minor', true)).toEqual([
      'C',
      'D',
      'E',
      'F',
      'G',
      'A',
      'A#',
    ])
  })

  it('shows only natural notes for C major when key lock is on', () => {
    expect(visibleLabels('C', 'major', true)).toEqual([
      'C',
      'D',
      'E',
      'F',
      'G',
      'A',
      'B',
    ])
  })

  it('shows all chromatic notes when key lock is off', () => {
    expect(visibleLabels('G', 'major', false)).toEqual([
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
    ])
  })
})

function visibleLabels(
  keyName: Parameters<typeof liveKeyWheelNotes>[0],
  scaleName: Parameters<typeof liveKeyWheelNotes>[1],
  keyLock: boolean,
) {
  return liveKeyWheelNotes(keyName, scaleName, keyLock)
    .filter((note) => note.visible)
    .map((note) => note.label)
}
