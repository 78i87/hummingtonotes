import type { AdjustedNote } from './types'

type WindowWithAudioPrefixes = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

export interface PlaybackEvent {
  time: number
  duration: number
  frequency: number
  velocity: number
}

export interface PlaybackHandle {
  stop: () => void
}

const HARMONICS = [
  { multiple: 1, gain: 0.75 },
  { multiple: 2, gain: 0.24 },
  { multiple: 3, gain: 0.11 },
  { multiple: 4, gain: 0.06 },
]

export function createPlaybackEvents(notes: AdjustedNote[]): PlaybackEvent[] {
  return notes
    .map((note) => ({
      time: Math.max(0, note.quantizedStart),
      duration: Math.max(0.05, note.quantizedDuration),
      frequency: midiToFrequency(note.midi),
      velocity: Math.max(0.1, Math.min(1, note.velocity)),
    }))
    .sort((a, b) => a.time - b.time)
}

export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

export async function playPianoNotes(
  notes: AdjustedNote[],
  onEnded: () => void,
): Promise<PlaybackHandle> {
  const events = createPlaybackEvents(notes)
  const AudioContextCtor =
    window.AudioContext ??
    (window as WindowWithAudioPrefixes).webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error('This browser does not support Web Audio playback.')
  }

  if (events.length === 0) {
    onEnded()
    return { stop: () => undefined }
  }

  const context = new AudioContextCtor()
  await context.resume()

  const master = context.createGain()
  master.gain.value = 0.72

  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = -18
  compressor.knee.value = 18
  compressor.ratio.value = 3
  compressor.attack.value = 0.004
  compressor.release.value = 0.18

  master.connect(compressor)
  compressor.connect(context.destination)

  const startAt = context.currentTime + 0.08
  const scheduledNodes: AudioScheduledSourceNode[] = []

  events.forEach((event) => {
    schedulePianoNote(context, master, event, startAt, scheduledNodes)
  })

  const finalEvent = events[events.length - 1]
  const endAfterSeconds = finalEvent.time + finalEvent.duration + 0.7
  const endTimer = window.setTimeout(() => {
    void context.close()
    onEnded()
  }, endAfterSeconds * 1000)

  return {
    stop: () => {
      window.clearTimeout(endTimer)
      scheduledNodes.forEach((node) => {
        try {
          node.stop()
        } catch {
          // Nodes may already have stopped naturally.
        }
      })
      void context.close()
      onEnded()
    },
  }
}

function schedulePianoNote(
  context: AudioContext,
  destination: AudioNode,
  event: PlaybackEvent,
  startAt: number,
  scheduledNodes: AudioScheduledSourceNode[],
) {
  const noteStart = startAt + event.time
  const noteEnd = noteStart + event.duration
  const releaseEnd = noteEnd + 0.42

  const noteGain = context.createGain()
  noteGain.gain.setValueAtTime(0.0001, noteStart)
  noteGain.gain.exponentialRampToValueAtTime(0.34 * event.velocity, noteStart + 0.01)
  noteGain.gain.exponentialRampToValueAtTime(0.12 * event.velocity, noteStart + 0.16)
  noteGain.gain.setValueAtTime(0.1 * event.velocity, noteEnd)
  noteGain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd)

  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(5200, noteStart)
  filter.frequency.exponentialRampToValueAtTime(1600, releaseEnd)
  filter.Q.value = 0.7

  noteGain.connect(filter)
  filter.connect(destination)

  HARMONICS.forEach((harmonic) => {
    const oscillator = context.createOscillator()
    const harmonicGain = context.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(
      event.frequency * harmonic.multiple,
      noteStart,
    )
    harmonicGain.gain.value = harmonic.gain

    oscillator.connect(harmonicGain)
    harmonicGain.connect(noteGain)
    oscillator.start(noteStart)
    oscillator.stop(releaseEnd)
    scheduledNodes.push(oscillator)
  })
}
