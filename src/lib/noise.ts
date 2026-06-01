import type { DetectedNote } from './types'

export interface NoiseCleanupResult {
  notes: DetectedNote[]
  removedCount: number
  originalCount: number
}

export function cleanupNoiseArtifacts(
  notes: DetectedNote[],
  strength: number,
): NoiseCleanupResult {
  if (notes.length === 0 || strength <= 0) {
    return {
      notes: [...notes],
      removedCount: 0,
      originalCount: notes.length,
    }
  }

  const safeStrength = clamp(strength, 0, 1)
  const sortedNotes = [...notes].sort((a, b) => a.start - b.start)
  const cleaned = sortedNotes.filter((note, index) => {
    const previous = sortedNotes[index - 1]
    const next = sortedNotes[index + 1]
    return !isLikelyNoisePitch(note, previous, next, safeStrength)
  })

  return {
    notes: cleaned,
    removedCount: sortedNotes.length - cleaned.length,
    originalCount: notes.length,
  }
}

function isLikelyNoisePitch(
  note: DetectedNote,
  previous: DetectedNote | undefined,
  next: DetectedNote | undefined,
  strength: number,
): boolean {
  const maxArtifactDuration = 0.08 + 0.12 * strength
  if (note.duration > maxArtifactDuration) {
    return false
  }

  const farFromPrevious =
    !previous || Math.abs(note.midi - previous.midi) >= 5 + 3 * strength
  const farFromNext =
    !next || Math.abs(note.midi - next.midi) >= 5 + 3 * strength
  if (!farFromPrevious || !farFromNext) {
    return false
  }

  const nearNeighbor =
    (previous && gapSeconds(previous, note) <= 0.18 + 0.12 * strength) ||
    (next && gapSeconds(note, next) <= 0.18 + 0.12 * strength)
  const weakEnough = note.confidence <= 0.45 + 0.35 * strength

  return Boolean(nearNeighbor) && weakEnough
}

function gapSeconds(first: DetectedNote, second: DetectedNote): number {
  return second.start - (first.start + first.duration)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
