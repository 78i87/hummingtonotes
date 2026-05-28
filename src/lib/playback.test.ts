import { describe, expect, it } from 'vitest'

import { createPlaybackEvents, midiToFrequency } from './playback'
import type { AdjustedNote } from './types'

describe('piano playback scheduling', () => {
  it('converts MIDI note numbers to equal-tempered frequency', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440)
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 2)
  })

  it('creates sorted playback events from adjusted notes', () => {
    const events = createPlaybackEvents([
      adjustedNote('late', 64, 1, 0.5),
      adjustedNote('early', 60, 0, 0.25),
    ])

    expect(events.map((event) => event.time)).toEqual([0, 1])
    expect(events[0]?.duration).toBe(0.25)
    expect(events[1]?.frequency).toBeCloseTo(midiToFrequency(64))
  })
})

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
