import { Midi } from '@tonejs/midi'

import type {
  AdjustedNote,
  AnalysisSettings,
  CapturedClip,
  PerformanceEvent,
} from './types'

export function createMidiBytes(
  notes: AdjustedNote[],
  settings: AnalysisSettings,
): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(settings.tempo)
  midi.name = 'Hummed melody'

  const track = midi.addTrack()
  track.name = 'Corrected melody'
  track.instrument.number = 52

  notes.forEach((note) => {
    track.addNote({
      midi: note.midi,
      time: note.quantizedStart,
      duration: Math.max(0.05, note.quantizedDuration),
      velocity: Math.max(0.1, Math.min(1, note.velocity)),
    })

    if (settings.exportPitchBends && note.pitchBends.length > 0) {
      note.pitchBends.forEach((bend, index) => {
        track.addPitchBend({
          time:
            note.quantizedStart +
            (note.quantizedDuration * index) / note.pitchBends.length,
          value: bend,
        })
      })
    }
  })

  return midi.toArray()
}

export function createMidiBlob(
  notes: AdjustedNote[],
  settings: AnalysisSettings,
): Blob {
  const bytes = createMidiBytes(notes, settings)
  return bytesToBlob(bytes)
}

export function createPerformanceMidiBytes(
  clip: CapturedClip,
  tempo: number,
): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(tempo)
  midi.name = 'Vocal controller capture'

  const pitchTrack = midi.addTrack()
  pitchTrack.name = 'Pitch'
  pitchTrack.instrument.number = 52

  clip.cleanedNotes.forEach((note) => {
    pitchTrack.addNote({
      midi: note.midi,
      time: note.quantizedStart,
      duration: Math.max(0.05, note.quantizedDuration),
      velocity: Math.max(0.1, Math.min(1, note.velocity)),
    })

    note.pitchBends.forEach((bend, index) => {
      pitchTrack.addPitchBend({
        time:
          note.quantizedStart +
          (note.quantizedDuration * index) / Math.max(1, note.pitchBends.length),
        value: bend,
      })
    })
  })

  const chordTrack = midi.addTrack()
  chordTrack.name = 'Chords'
  chordTrack.instrument.number = 0

  const triggerTrack = midi.addTrack()
  triggerTrack.name = 'Triggers'
  triggerTrack.channel = 9

  const ccTrack = midi.addTrack()
  ccTrack.name = 'Voice CC'

  clip.rawEvents.forEach((event) => {
    addPerformanceEvent(event, chordTrack, triggerTrack, ccTrack)
  })

  return midi.toArray()
}

export function createPerformanceMidiBlob(
  clip: CapturedClip,
  tempo: number,
): Blob {
  return bytesToBlob(createPerformanceMidiBytes(clip, tempo))
}

function addPerformanceEvent(
  event: PerformanceEvent,
  chordTrack: ReturnType<Midi['addTrack']>,
  triggerTrack: ReturnType<Midi['addTrack']>,
  ccTrack: ReturnType<Midi['addTrack']>,
) {
  if (event.type === 'chord') {
    event.notes.forEach((midiNote) => {
      chordTrack.addNote({
        midi: midiNote,
        time: event.time,
        duration: Math.max(0.08, event.duration),
        velocity: event.velocity,
      })
    })
  }

  if (event.type === 'trigger') {
    triggerTrack.addNote({
      midi: event.midi,
      time: event.time,
      duration: 0.08,
      velocity: event.velocity,
    })
  }

  if (event.type === 'cc') {
    ccTrack.addCC({
      number: event.cc,
      time: event.time,
      value: Math.max(0, Math.min(1, event.value / 127)),
    })
  }
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)

  return new Blob([arrayBuffer], {
    type: 'audio/midi',
  })
}
