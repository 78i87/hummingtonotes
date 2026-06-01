import { describe, expect, it } from 'vitest'

import { cleanupNoiseArtifacts } from './noise'
import type { DetectedNote } from './types'

describe('noise cleanup', () => {
  it('removes short weak high pitch blips between melody notes', () => {
    const result = cleanupNoiseArtifacts(
      [
        note('a', 60, 0, 0.3, 0.9),
        note('noise', 82, 0.32, 0.06, 0.35),
        note('b', 62, 0.42, 0.3, 0.9),
      ],
      0.8,
    )

    expect(result.removedCount).toBe(1)
    expect(result.notes.map((candidate) => candidate.id)).toEqual(['a', 'b'])
  })

  it('keeps real short notes that continue the melody contour', () => {
    const result = cleanupNoiseArtifacts(
      [
        note('a', 60, 0, 0.3, 0.9),
        note('passing', 61, 0.34, 0.08, 0.8),
        note('b', 62, 0.46, 0.3, 0.9),
      ],
      0.8,
    )

    expect(result.removedCount).toBe(0)
    expect(result.notes).toHaveLength(3)
  })

  it('leaves notes unchanged when strength is zero', () => {
    const notes = [
      note('a', 60, 0, 0.3, 0.9),
      note('noise', 82, 0.32, 0.06, 0.2),
    ]
    const result = cleanupNoiseArtifacts(notes, 0)

    expect(result.removedCount).toBe(0)
    expect(result.notes).toEqual(notes)
  })
})

function note(
  id: string,
  midi: number,
  start: number,
  duration: number,
  confidence: number,
): DetectedNote {
  return {
    id,
    start,
    duration,
    midi,
    velocity: confidence,
    pitchBends: [],
    confidence,
  }
}
