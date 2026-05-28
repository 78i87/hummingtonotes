import type { DetectedNote } from './types'

export interface SyntheticMelodyFixture {
  samples: Float32Array
  sampleRate: number
  notes: DetectedNote[]
}

export function createDetunedSineMelodyFixture(): SyntheticMelodyFixture {
  const sampleRate = 22050
  const midiNotes = [61.2, 63.1, 65.2, 66.8, 68.9]
  const duration = 0.38
  const gap = 0.06
  const totalSeconds = midiNotes.length * (duration + gap)
  const samples = new Float32Array(Math.ceil(totalSeconds * sampleRate))
  const notes: DetectedNote[] = []

  midiNotes.forEach((midi, index) => {
    const start = index * (duration + gap)
    const frequency = 440 * 2 ** ((midi - 69) / 12)
    const startSample = Math.floor(start * sampleRate)
    const endSample = Math.min(
      samples.length,
      startSample + Math.floor(duration * sampleRate),
    )

    for (let sample = startSample; sample < endSample; sample += 1) {
      const localTime = (sample - startSample) / sampleRate
      const envelope = Math.min(
        1,
        localTime / 0.04,
        (duration - localTime) / 0.04,
      )
      samples[sample] =
        Math.sin(2 * Math.PI * frequency * localTime) * 0.45 * envelope
    }

    notes.push({
      id: `fixture-${index}`,
      start,
      duration,
      midi,
      velocity: 0.8,
      pitchBends: [],
      confidence: 0.8,
    })
  })

  return { samples, sampleRate, notes }
}
