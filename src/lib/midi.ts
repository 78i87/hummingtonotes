import { Midi } from '@tonejs/midi'

import type { AdjustedNote, AnalysisSettings } from './types'

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
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)

  return new Blob([arrayBuffer], {
    type: 'audio/midi',
  })
}
