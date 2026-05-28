import { describe, expect, it } from 'vitest'

import { cleanupArticulation } from './articulation'
import type { DetectedNote } from './types'

describe('articulation cleanup', () => {
  it('merges repeated same-pitch short syllables into one note', () => {
    const result = cleanupArticulation(
      [
        note('a', 60, 0, 0.12),
        note('b', 60, 0.18, 0.1),
        note('c', 60, 0.34, 0.12),
      ],
      0.7,
    )

    expect(result.mergedCount).toBe(2)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]?.start).toBe(0)
    expect(result.notes[0]?.duration).toBeCloseTo(0.46)
    expect(Math.round(result.notes[0]?.midi ?? 0)).toBe(60)
  })

  it('does not merge different pitches', () => {
    const result = cleanupArticulation(
      [
        note('a', 60, 0, 0.12),
        note('b', 62, 0.18, 0.1),
      ],
      0.9,
    )

    expect(result.mergedCount).toBe(0)
    expect(result.notes.map((candidate) => candidate.id)).toEqual(['a', 'b'])
  })

  it('does not merge long repeated notes unnecessarily', () => {
    const result = cleanupArticulation(
      [
        note('a', 60, 0, 0.6),
        note('b', 60, 0.7, 0.55),
      ],
      0.9,
    )

    expect(result.mergedCount).toBe(0)
    expect(result.notes).toHaveLength(2)
  })

  it('leaves notes unchanged when strength is zero', () => {
    const notes = [
      note('a', 60, 0, 0.12),
      note('b', 60, 0.18, 0.1),
    ]
    const result = cleanupArticulation(notes, 0)

    expect(result.mergedCount).toBe(0)
    expect(result.notes).toEqual(notes)
  })

  it('uses higher strength to tolerate slightly larger syllable gaps', () => {
    const notes = [
      note('a', 60, 0, 0.12),
      note('b', 60, 0.34, 0.11),
    ]

    expect(cleanupArticulation(notes, 0.5).mergedCount).toBe(0)
    expect(cleanupArticulation(notes, 1).mergedCount).toBe(1)
  })

  it('duration-weights merged pitch, velocity, and confidence', () => {
    const result = cleanupArticulation(
      [
        note('a', 60.1, 0, 0.1, 0.4, 0.6),
        note('b', 59.8, 0.15, 0.3, 1, 0.9),
      ],
      0.8,
    )

    expect(result.notes[0]?.midi).toBeCloseTo(59.875)
    expect(result.notes[0]?.velocity).toBeCloseTo(0.85)
    expect(result.notes[0]?.confidence).toBeCloseTo(0.825)
  })
})

function note(
  id: string,
  midi: number,
  start: number,
  duration: number,
  velocity = 0.8,
  confidence = 0.8,
): DetectedNote {
  return {
    id,
    start,
    duration,
    midi,
    velocity,
    pitchBends: [],
    confidence,
  }
}
