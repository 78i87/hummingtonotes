import { describe, expect, it } from 'vitest'

import {
  adjustNotes,
  closestScaleMidi,
  defaultSettings,
  inferKey,
  quantizeSeconds,
} from './music'
import { createDetunedSineMelodyFixture } from './synthetic'
import type { AnalysisSettings, DetectedNote } from './types'

describe('music correction', () => {
  it('snaps MIDI notes to the selected scale', () => {
    expect(closestScaleMidi(61, 'C', 'major')).toBe(60)
    expect(closestScaleMidi(63, 'C', 'major')).toBe(62)
    expect(closestScaleMidi(66, 'C', 'minor')).toBe(65)
  })

  it('preserves relative melody while correcting an imperfect starting pitch', () => {
    const fixture = createDetunedSineMelodyFixture()
    const settings: AnalysisSettings = {
      ...defaultSettings({ key: 'C', scale: 'major', confidence: 1 }),
      correctionStrength: 1,
      quantizeStrength: 0,
    }

    const adjusted = adjustNotes(fixture.notes, settings)

    expect(adjusted.map((note) => note.noteName)).toEqual([
      'C4',
      'D4',
      'E4',
      'F4',
      'G4',
    ])
  })

  it('supports transposition after correction', () => {
    const notes: DetectedNote[] = [
      note('a', 60, 0),
      note('b', 62, 0.5),
      note('c', 64, 1),
    ]
    const settings: AnalysisSettings = {
      ...defaultSettings({ key: 'D', scale: 'major', confidence: 1 }),
      transpose: 2,
      correctionStrength: 1,
      quantizeStrength: 0,
    }

    expect(adjustNotes(notes, settings).map((adjusted) => adjusted.noteName)).toEqual([
      'D4',
      'E4',
      'F#4',
    ])
  })

  it('quantizes timing with configurable strength', () => {
    expect(quantizeSeconds(0.31, 120, 0.25, 1)).toBe(0.25)
    expect(quantizeSeconds(0.31, 120, 0.25, 0)).toBe(0.31)
  })

  it('infers a practical key from note content', () => {
    const suggestion = inferKey([
      note('c', 60, 0),
      note('e', 64, 0.5),
      note('g', 67, 1),
      note('c2', 72, 1.5),
    ])

    expect(suggestion.key).toBe('C')
    expect(suggestion.scale).toBe('major')
    expect(suggestion.fit).toBe(1)
    expect(suggestion.ambiguous).toBe(true)
  })

  it('creates a non-empty detuned sine fixture', () => {
    const fixture = createDetunedSineMelodyFixture()

    expect(fixture.sampleRate).toBe(22050)
    expect(fixture.notes).toHaveLength(5)
    expect(Math.max(...fixture.samples)).toBeGreaterThan(0.1)
  })
})

function note(id: string, midi: number, start: number): DetectedNote {
  return {
    id,
    start,
    duration: 0.4,
    midi,
    velocity: 0.8,
    pitchBends: [],
    confidence: 0.8,
  }
}
