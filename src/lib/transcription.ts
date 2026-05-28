import {
  BasicPitch,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
  outputToNotesPoly,
} from '@spotify/basic-pitch'

import { resampleToBasicPitchInput } from './audio'
import type { DetectedNote, RawTranscription } from './types'

const MODEL_URL = '/basic-pitch/model.json'
const ONSET_THRESHOLD = 0.25
const FRAME_THRESHOLD = 0.25
const MIN_NOTE_LENGTH_FRAMES = 5

let basicPitch: BasicPitch | undefined

export async function transcribeWithBasicPitch(
  audioBuffer: AudioBuffer,
  onProgress: (progress: number) => void,
): Promise<RawTranscription> {
  const samples = await resampleToBasicPitchInput(audioBuffer)
  const frames: number[][] = []
  const onsets: number[][] = []
  const contours: number[][] = []

  await getBasicPitch().evaluateModel(
    samples,
    (frameBatch, onsetBatch, contourBatch) => {
      frames.push(...frameBatch)
      onsets.push(...onsetBatch)
      contours.push(...contourBatch)
    },
    onProgress,
  )

  const noteEvents = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(
        frames,
        onsets,
        ONSET_THRESHOLD,
        FRAME_THRESHOLD,
        MIN_NOTE_LENGTH_FRAMES,
      ),
    ),
  )

  return {
    frames,
    onsets,
    contours,
    notes: noteEvents.map<DetectedNote>((note, index) => ({
      id: `note-${index}`,
      start: note.startTimeSeconds,
      duration: note.durationSeconds,
      midi: note.pitchMidi,
      velocity: note.amplitude,
      pitchBends: note.pitchBends ?? [],
      confidence: note.amplitude,
    })),
    duration: audioBuffer.duration,
  }
}

function getBasicPitch(): BasicPitch {
  basicPitch ??= new BasicPitch(MODEL_URL)
  return basicPitch
}
