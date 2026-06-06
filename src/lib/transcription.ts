import {
  BasicPitch,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
  outputToNotesPoly,
} from '@spotify/basic-pitch'

import { resampleToBasicPitchInput } from './audio'
import type { DetectedNote, RawTranscription } from './types'

const MODEL_URL = '/basic-pitch/model.json'
const DEFAULT_BASIC_PITCH_OPTIONS = {
  onsetThreshold: 0.32,
  frameThreshold: 0.22,
  minNoteLengthFrames: 6,
} satisfies BasicPitchTranscriptionOptions

let basicPitch: BasicPitch | undefined

export interface BasicPitchTranscriptionOptions {
  onsetThreshold?: number
  frameThreshold?: number
  minNoteLengthFrames?: number
}

export async function transcribeWithBasicPitch(
  audioBuffer: AudioBuffer,
  onProgress: (progress: number) => void,
  options: BasicPitchTranscriptionOptions = {},
): Promise<RawTranscription> {
  const samples = await resampleToBasicPitchInput(audioBuffer)
  const frames: number[][] = []
  const onsets: number[][] = []
  const contours: number[][] = []
  const resolvedOptions = {
    ...DEFAULT_BASIC_PITCH_OPTIONS,
    ...options,
  }

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
        resolvedOptions.onsetThreshold,
        resolvedOptions.frameThreshold,
        resolvedOptions.minNoteLengthFrames,
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
