import type { DetectedNote } from './types'

export interface ArticulationCleanupResult {
  notes: DetectedNote[]
  mergedCount: number
  originalCount: number
}

export function cleanupArticulation(
  notes: DetectedNote[],
  strength: number,
): ArticulationCleanupResult {
  if (notes.length === 0 || strength <= 0) {
    return {
      notes: [...notes],
      mergedCount: 0,
      originalCount: notes.length,
    }
  }

  const sortedNotes = [...notes].sort((a, b) => a.start - b.start)
  const cleaned: DetectedNote[] = []
  let current = sortedNotes[0]
  let mergedCount = 0

  for (let index = 1; index < sortedNotes.length; index += 1) {
    const next = sortedNotes[index]

    if (shouldMergeSyllableFragment(current, next, strength)) {
      current = mergeNotes(current, next)
      mergedCount += 1
      continue
    }

    cleaned.push(current)
    current = next
  }

  cleaned.push(current)

  return {
    notes: cleaned,
    mergedCount,
    originalCount: notes.length,
  }
}

function shouldMergeSyllableFragment(
  current: DetectedNote,
  next: DetectedNote,
  strength: number,
): boolean {
  const safeStrength = clamp(strength, 0, 1)
  const samePitch = Math.round(current.midi) === Math.round(next.midi)
  if (!samePitch) {
    return false
  }

  const gap = next.start - (current.start + current.duration)
  const maxGap = 0.04 + 0.2 * safeStrength
  if (gap < -0.04 || gap > maxGap) {
    return false
  }

  const maxShortDuration = 0.08 + 0.2 * safeStrength
  const hasShortFragment =
    current.duration <= maxShortDuration || next.duration <= maxShortDuration
  if (!hasShortFragment) {
    return false
  }

  const combinedDuration =
    Math.max(current.start + current.duration, next.start + next.duration) -
    Math.min(current.start, next.start)
  const maxCombinedDuration = 1.4 + 3 * safeStrength
  return combinedDuration <= maxCombinedDuration
}

function mergeNotes(first: DetectedNote, second: DetectedNote): DetectedNote {
  const start = Math.min(first.start, second.start)
  const end = Math.max(
    first.start + first.duration,
    second.start + second.duration,
  )
  const duration = end - start
  const weight = Math.max(0.001, first.duration + second.duration)

  return {
    id: `${first.id}+${second.id}`,
    start,
    duration,
    midi: weightedAverage(first.midi, second.midi, first.duration, second.duration),
    velocity: weightedAverage(
      first.velocity,
      second.velocity,
      first.duration,
      second.duration,
    ),
    confidence: weightedAverage(
      first.confidence,
      second.confidence,
      first.duration,
      second.duration,
    ),
    pitchBends: [...first.pitchBends, ...second.pitchBends],
  }

  function weightedAverage(
    firstValue: number,
    secondValue: number,
    firstWeight: number,
    secondWeight: number,
  ): number {
    return (firstValue * firstWeight + secondValue * secondWeight) / weight
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
