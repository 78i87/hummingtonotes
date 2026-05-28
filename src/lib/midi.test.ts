import { Midi } from '@tonejs/midi'
import { describe, expect, it } from 'vitest'

import { createMidiBytes } from './midi'
import type { AdjustedNote, AnalysisSettings } from './types'

describe('midi export', () => {
  it('writes adjusted notes into a playable MIDI track', () => {
    const bytes = createMidiBytes(
      [
        adjustedNote('a', 60, 0, 0.5),
        adjustedNote('b', 64, 0.5, 0.5),
      ],
      settings(false),
    )
    const midi = new Midi(bytes)

    expect(midi.tracks).toHaveLength(1)
    expect(midi.tracks[0]?.notes.map((note) => note.midi)).toEqual([60, 64])
    expect(midi.tracks[0]?.notes[1]?.time).toBeCloseTo(0.5)
  })

  it('can include Basic Pitch pitch bend data when enabled', () => {
    const bytes = createMidiBytes(
      [
        {
          ...adjustedNote('a', 60, 0, 0.5),
          pitchBends: [0, 0.1, -0.1],
        },
      ],
      settings(true),
    )
    const midi = new Midi(bytes)

    expect(midi.tracks[0]?.pitchBends).toHaveLength(3)
  })
})

function settings(exportPitchBends: boolean): AnalysisSettings {
  return {
    key: 'C',
    scale: 'major',
    transpose: 0,
    articulationCleanup: 0.7,
    correctionStrength: 1,
    tempo: 120,
    grid: 0.25,
    quantizeStrength: 1,
    exportPitchBends,
  }
}

function adjustedNote(
  id: string,
  midi: number,
  start: number,
  duration: number,
): AdjustedNote {
  return {
    id,
    rawId: id,
    start,
    duration,
    quantizedStart: start,
    quantizedDuration: duration,
    rawMidi: midi,
    midi,
    rawNoteName: 'C4',
    noteName: 'C4',
    velocity: 0.8,
    pitchBends: [],
    confidence: 0.8,
  }
}
