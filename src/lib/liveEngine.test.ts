import { describe, expect, it } from 'vitest'

import {
  analyzeLiveFrame,
  calibrateVoiceFromFrames,
  chordNotesForRoot,
  cleanupCapturedClip,
  classifyTrigger,
  createLiveEngineState,
  estimatePitchYin,
  effectiveInputThreshold,
  extractTriggerFeature,
  inferKeyFromPerformance,
  mergeClipWithBasicPitch,
  noteEventsForFrame,
  smoothCcEvents,
} from './liveEngine'
import { createDefaultProfile } from './profile'
import type { LivePitchFrame, TriggerFeature } from './types'

describe('live vocal engine', () => {
  it('estimates a clean monophonic pitch with YIN', () => {
    const sampleRate = 16000
    const samples = sine(440, sampleRate, 1024)
    const estimate = estimatePitchYin(samples, sampleRate, 0.18)

    expect(estimate?.frequency).toBeCloseTo(440, 0)
    expect(estimate?.midi).toBeCloseTo(69, 0)
  })

  it('uses continuity to prefer the fundamental in harmonic-rich input', () => {
    const sampleRate = 16000
    const samples = harmonicRichSine(220, sampleRate, 1024)
    const estimate = estimatePitchYin(samples, sampleRate, 0.18, {
      referenceMidi: 57,
      referenceConfidence: 0.93,
    })

    expect(estimate?.midi).toBeCloseTo(57, 0)
  })

  it('does not pin large non-octave interval jumps to the previous note', () => {
    const sampleRate = 16000
    const samples = sine(392, sampleRate, 1024)
    const estimate = estimatePitchYin(samples, sampleRate, 0.18, {
      referenceMidi: 60,
      referenceConfidence: 0.93,
    })

    expect(estimate?.midi).toBeCloseTo(67, 0)
  })

  it('accepts quiet high-confidence pitch above the adaptive input floor', () => {
    const profile = {
      ...createDefaultProfile(),
      calibration: {
        ...createDefaultProfile().calibration,
        noiseFloorRms: 0.004,
        vocalRms: 0.08,
        rmsThreshold: 0.03,
      },
    }
    const result = analyzeLiveFrame(
      sine(440, 16000, 1024, 0.025),
      16000,
      0,
      profile,
      createLiveEngineState(),
    )

    expect(result.frame.rms).toBeLessThan(profile.calibration.rmsThreshold)
    expect(result.frame.voiced).toBe(true)
    expect(result.frame.lockedMidi).toBe(69)
  })

  it('rejects input below the adaptive input floor', () => {
    const profile = createDefaultProfile()
    const result = analyzeLiveFrame(
      sine(440, 16000, 1024, 0.002),
      16000,
      0,
      profile,
      createLiveEngineState(),
    )

    expect(result.frame.voiced).toBe(false)
    expect(result.events.some((event) => event.type === 'noteOn')).toBe(false)
  })

  it('scales calibrated thresholds when input level changes', () => {
    const calibration = {
      ...createDefaultProfile().calibration,
      inputLevel: 1,
      noiseFloorRms: 0.006,
      vocalRms: 0.1,
      rmsThreshold: 0.03,
    }

    expect(effectiveInputThreshold(calibration, 2)).toBeCloseTo(
      effectiveInputThreshold(calibration, 1) * 2,
    )
  })

  it('updates voice RMS without changing pitch range when pitch is not stable', () => {
    const calibration = {
      ...createDefaultProfile().calibration,
      noiseFloorRms: 0.004,
      vocalRms: 0.04,
      minMidi: 48,
      maxMidi: 72,
    }
    const update = calibrateVoiceFromFrames(
      calibration,
      [
        unvoicedFrame(0, 0.05),
        unvoicedFrame(0.02, 0.055),
        unvoicedFrame(0.04, 0.052),
      ],
      1.4,
    )

    expect(update?.calibration.vocalRms).toBeGreaterThan(calibration.vocalRms)
    expect(update?.calibration.inputLevel).toBe(1.4)
    expect(update?.calibration.minMidi).toBe(48)
    expect(update?.calibration.maxMidi).toBe(72)
    expect(update?.feedback).toBe('pitchRangeUnchanged')
  })

  it('keeps IntelliBend anchored until a new note is stable', () => {
    const state = createLiveEngineState()
    const first = noteEventsForFrame(frame(0, 60, 0), 'intellibend', state)
    const earlySwitch = noteEventsForFrame(frame(0.04, 62, 0), 'intellibend', state)
    const committedSwitch = noteEventsForFrame(frame(0.13, 62, 0), 'intellibend', state)

    expect(first.some((event) => event.type === 'noteOn' && event.midi === 60)).toBe(true)
    expect(earlySwitch.some((event) => event.type === 'noteOn' && event.midi === 62)).toBe(false)
    expect(committedSwitch.some((event) => event.type === 'noteOn' && event.midi === 62)).toBe(true)
  })

  it('keeps an active note through one low-energy dip', () => {
    const state = createLiveEngineState()
    noteEventsForFrame(frameWithRms(0, 60, 0, 0.2), 'intellibend', state)
    const dip = noteEventsForFrame(frameWithRms(0.08, 60, 0, 0.03), 'intellibend', state)

    expect(dip.some((event) => event.type === 'noteOff')).toBe(false)
    expect(state.activeMidi).toBe(60)
  })

  it('releases an active note after consecutive low-energy frames', () => {
    const state = createLiveEngineState()
    noteEventsForFrame(frameWithRms(0, 60, 0, 0.2), 'intellibend', state)
    noteEventsForFrame(frameWithRms(0.08, 60, 0, 0.03), 'intellibend', state)
    const release = noteEventsForFrame(frameWithRms(0.1, 60, 0, 0.03), 'intellibend', state)

    expect(release.some((event) => event.type === 'noteOff' && event.midi === 60)).toBe(true)
    expect(state.activeMidi).toBeNull()
  })

  it('uses pitch stickiness to reject shallow adjacent-note wobble', () => {
    const looseState = createLiveEngineState()
    noteEventsForFrame(frame(0, 60, 0), 'intellibend', looseState, 0)
    noteEventsForFrame(frame(0.02, 61, -45), 'intellibend', looseState, 0)
    const looseSwitch = noteEventsForFrame(frame(0.08, 61, -45), 'intellibend', looseState, 0)

    const stickyState = createLiveEngineState()
    noteEventsForFrame(frame(0, 60, 0), 'intellibend', stickyState, 1)
    noteEventsForFrame(frame(0.02, 61, -45), 'intellibend', stickyState, 1)
    const stickySwitch = noteEventsForFrame(frame(0.16, 61, -45), 'intellibend', stickyState, 1)

    expect(looseSwitch.some((event) => event.type === 'noteOn' && event.midi === 61)).toBe(true)
    expect(stickySwitch.some((event) => event.type === 'noteOn' && event.midi === 61)).toBe(false)
  })

  it('uses immediate switching in TruBend mode', () => {
    const state = createLiveEngineState()
    noteEventsForFrame(frame(0, 60, 0), 'trubend', state)
    const switchEvents = noteEventsForFrame(frame(0.02, 62, 0), 'trubend', state)

    expect(switchEvents.some((event) => event.type === 'noteOn' && event.midi === 62)).toBe(true)
  })

  it('uses the transformed output note as the TruBend MIDI target', () => {
    const state = createLiveEngineState()
    const first = noteEventsForFrame(
      frameWithEstimate(0, 60, 48, 0),
      'trubend',
      state,
    )
    const switchEvents = noteEventsForFrame(
      frameWithEstimate(0.02, 62, 50, 0),
      'trubend',
      state,
    )

    expect(first.some((event) => event.type === 'noteOn' && event.midi === 48)).toBe(true)
    expect(switchEvents.some((event) => event.type === 'noteOn' && event.midi === 50)).toBe(true)
  })

  it('builds cluster and spread chord voicings', () => {
    expect(chordNotesForRoot(60, 'majorTriad', 'cluster', 'C', 'major')).toEqual([
      60, 64, 67,
    ])
    expect(chordNotesForRoot(60, 'majorTriad', 'spread', 'C', 'major')).toEqual([
      60, 64, 79,
    ])
  })

  it('classifies trained percussive trigger features by nearest slot', () => {
    const slots = createDefaultProfile().triggers.map((slot) =>
      slot.id === 'kick'
        ? {
            ...slot,
            examples: [triggerFeature(1, 0.7, 1, 0.2, 0.1)],
          }
        : slot,
    )
    const match = classifyTrigger(triggerFeature(0.96, 0.68, 1, 0.22, 0.08), slots)

    expect(match?.id).toBe('kick')
  })

  it('extracts normalized trigger features from a transient', () => {
    const samples = new Float32Array([1, -0.8, 0.4, -0.2, 0.05, 0])
    const feature = extractTriggerFeature(samples)

    expect(feature.peak).toBeCloseTo(1)
    expect(feature.attack).toBeGreaterThan(feature.rms)
  })

  it('smooths CC values per controller', () => {
    const smoothed = smoothCcEvents(
      [
        { id: 'a', type: 'cc', time: 0, cc: 74, value: 0 },
        { id: 'b', type: 'cc', time: 0.01, cc: 74, value: 100 },
      ],
      0.5,
    )

    expect(smoothed[1]?.value).toBe(50)
  })

  it('smooths CC values across live frames when state is reused', () => {
    const previous = new Map<number, number>()
    smoothCcEvents([{ id: 'a', type: 'cc', time: 0, cc: 74, value: 0 }], 0.5, previous)
    const smoothed = smoothCcEvents(
      [{ id: 'b', type: 'cc', time: 0.01, cc: 74, value: 100 }],
      0.5,
      previous,
    )

    expect(smoothed[0]?.value).toBe(50)
  })

  it('cleans captured note-on/off events into notes', () => {
    const profile = createDefaultProfile()
    const clip = cleanupCapturedClip({
      duration: 0.7,
      frames: [frame(0, 60, 0), frame(0.3, 60, 0)],
      profile,
      events: [
        { id: 'on', type: 'noteOn', time: 0, midi: 60, velocity: 0.8 },
        { id: 'off', type: 'noteOff', time: 0.4, midi: 60 },
      ],
    })

    expect(clip.cleanedNotes).toHaveLength(1)
    expect(clip.cleanedNotes[0]?.duration).toBeCloseTo(0.4)
  })

  it('can use Basic Pitch notes as post-capture cleanup', () => {
    const profile = createDefaultProfile()
    const clip = cleanupCapturedClip({
      duration: 1,
      frames: [],
      profile,
      events: [
        { id: 'on', type: 'noteOn', time: 0, midi: 60, velocity: 0.8 },
        { id: 'off', type: 'noteOff', time: 0.4, midi: 60 },
      ],
    })
    const merged = mergeClipWithBasicPitch(clip, [
      {
        id: 'basic',
        start: 0.02,
        duration: 0.5,
        midi: 64.2,
        velocity: 0.7,
        pitchBends: [0.1],
        confidence: 0.9,
      },
    ])

    expect(merged.cleanedNotes[0]?.midi).toBe(64)
    expect(merged.cleanedNotes[0]?.pitchBends).toEqual([0.1])
  })

  it('uses Basic Pitch boundaries when live frames support the note', () => {
    const profile = createDefaultProfile()
    const clip = clipWithLiveNotes(profile, [
      adjustedNote('live-c', 0, 1, 60, 0.86, 0.85),
    ])
    const merged = mergeClipWithBasicPitch(
      {
        ...clip,
        rawFrames: [frame(0.12, 60, 0), frame(0.3, 60, 0), frame(0.56, 60, 0)],
      },
      [detectedNote('basic-c', 0.1, 0.5, 60, 0.7, 0.78)],
      profile,
    )

    expect(merged.cleanedNotes).toHaveLength(1)
    expect(merged.cleanedNotes[0]?.midi).toBe(60)
    expect(merged.cleanedNotes[0]?.start).toBeCloseTo(0.1)
    expect(merged.cleanedNotes[0]?.duration).toBeCloseTo(0.5)
  })

  it('rejects unsupported low-confidence Basic Pitch artifacts', () => {
    const profile = createDefaultProfile()
    const clip = clipWithLiveNotes(profile, [
      adjustedNote('live-c', 0, 0.7, 60, 0.86, 0.85),
    ])
    const merged = mergeClipWithBasicPitch(
      {
        ...clip,
        rawFrames: [frame(0.1, 60, 0), frame(0.35, 60, 0), frame(0.6, 60, 0)],
      },
      [detectedNote('artifact', 0.2, 0.12, 84, 0.18, 0.2)],
      profile,
    )

    expect(merged.cleanedNotes).toHaveLength(1)
    expect(merged.cleanedNotes[0]?.midi).toBe(60)
  })

  it('keeps confident live-only notes when Basic Pitch misses them', () => {
    const profile = createDefaultProfile()
    const clip = clipWithLiveNotes(profile, [
      adjustedNote('live-c', 0, 0.3, 60, 0.86, 0.85),
      adjustedNote('live-e', 0.55, 0.35, 64, 0.84, 0.83),
    ])
    const merged = mergeClipWithBasicPitch(
      {
        ...clip,
        rawFrames: [
          frame(0.08, 60, 0),
          frame(0.22, 60, 0),
          frame(0.6, 64, 0),
          frame(0.82, 64, 0),
        ],
      },
      [detectedNote('basic-c', 0, 0.32, 60, 0.72, 0.82)],
      profile,
    )

    expect(merged.cleanedNotes.map((note) => note.midi)).toEqual([60, 64])
  })

  it('merges adjacent Basic Pitch fragments into one sustained note', () => {
    const profile = createDefaultProfile()
    const clip = cleanupCapturedClip({
      duration: 0.7,
      frames: [],
      profile,
      events: [],
    })
    const merged = mergeClipWithBasicPitch(clip, [
      detectedNote('a', 0, 0.1, 53, 0.72, 0.8),
      detectedNote('b', 0.1, 0.1, 53, 0.74, 0.82),
      detectedNote('c', 0.23, 0.12, 53, 0.67, 0.76),
      detectedNote('d', 0.36, 0.14, 53, 0.7, 0.78),
    ])

    expect(merged.cleanedNotes).toHaveLength(1)
    expect(merged.cleanedNotes[0]?.midi).toBe(53)
    expect(merged.cleanedNotes[0]?.duration).toBeCloseTo(0.5)
  })

  it('removes isolated octave artifacts before merging surrounding notes', () => {
    const profile = createDefaultProfile()
    const clip = cleanupCapturedClip({
      duration: 0.8,
      frames: [],
      profile,
      events: [],
    })
    const merged = mergeClipWithBasicPitch(clip, [
      detectedNote('f-a', 0, 0.3, 53, 0.76, 0.86),
      detectedNote('artifact', 0.31, 0.09, 87, 0.34, 0.34),
      detectedNote('f-b', 0.42, 0.28, 53, 0.78, 0.82),
    ], profile)

    expect(merged.cleanedNotes).toHaveLength(1)
    expect(merged.cleanedNotes[0]?.midi).toBe(53)
    expect(merged.cleanedNotes[0]?.duration).toBeCloseTo(0.7)
  })

  it('snaps Basic Pitch cleanup to the active key before consolidation', () => {
    const profile = {
      ...createDefaultProfile(),
      pitch: {
        ...createDefaultProfile().pitch,
        key: 'D' as const,
        scale: 'minor' as const,
        keyLock: true,
      },
    }
    const clip = cleanupCapturedClip({
      duration: 0.5,
      frames: [],
      profile,
      events: [],
    })
    const merged = mergeClipWithBasicPitch(clip, [
      detectedNote('g-sharp', 0, 0.18, 56, 0.62, 0.7),
      detectedNote('g', 0.18, 0.18, 55, 0.82, 0.82),
    ], profile)

    expect(merged.cleanedNotes).toHaveLength(1)
    expect(merged.cleanedNotes[0]?.midi).toBe(55)
  })

  it('infers key from estimated frame pitch instead of scale-locked notes', () => {
    const profile = {
      ...createDefaultProfile(),
      pitch: {
        ...createDefaultProfile().pitch,
        key: 'C' as const,
        scale: 'major' as const,
        keyLock: true,
      },
    }
    const suggestion = inferKeyFromPerformance(
      [],
      [
        frameWithEstimate(0, 62, 60, 0),
        frameWithEstimate(0.02, 66, 60, 0),
        frameWithEstimate(0.04, 69, 60, 0),
        frameWithEstimate(0.06, 62, 60, 0),
        frameWithEstimate(0.08, 66, 60, 0),
        frameWithEstimate(0.1, 69, 60, 0),
      ],
      profile,
    )

    expect(suggestion.key).toBe('D')
    expect(suggestion.scale).toBe('major')
  })
})

function frame(time: number, lockedMidi: number, centsOffset: number): LivePitchFrame {
  return {
    time,
    rms: 0.1,
    estimatedMidi: lockedMidi + centsOffset / 100,
    lockedMidi,
    centsOffset,
    confidence: 0.9,
    voiced: true,
  }
}

function frameWithRms(
  time: number,
  lockedMidi: number,
  centsOffset: number,
  frameRms: number,
): LivePitchFrame {
  return {
    ...frame(time, lockedMidi, centsOffset),
    rms: frameRms,
  }
}

function frameWithEstimate(
  time: number,
  estimatedMidi: number,
  lockedMidi: number,
  centsOffset: number,
): LivePitchFrame {
  return {
    time,
    rms: 0.1,
    estimatedMidi,
    lockedMidi,
    centsOffset,
    confidence: 0.9,
    voiced: true,
  }
}

function unvoicedFrame(time: number, frameRms: number): LivePitchFrame {
  return {
    time,
    rms: frameRms,
    estimatedMidi: null,
    lockedMidi: null,
    centsOffset: 0,
    confidence: 0,
    voiced: false,
  }
}

function triggerFeature(
  attack: number,
  rms: number,
  peak: number,
  brightness: number,
  noisiness: number,
): TriggerFeature {
  return { attack, rms, peak, brightness, noisiness }
}

function harmonicRichSine(
  frequency: number,
  sampleRate: number,
  frameSize: number,
): Float32Array {
  const samples = new Float32Array(frameSize)
  for (let index = 0; index < frameSize; index += 1) {
    const phase = (Math.PI * 2 * frequency * index) / sampleRate
    samples[index] =
      Math.sin(phase) * 0.32 +
      Math.sin(phase * 2) * 0.78 +
      Math.sin(phase * 3) * 0.18
  }
  return samples
}

function sine(
  frequency: number,
  sampleRate: number,
  frameSize: number,
  amplitude = 0.7,
): Float32Array {
  const samples = new Float32Array(frameSize)
  for (let index = 0; index < frameSize; index += 1) {
    samples[index] = Math.sin((Math.PI * 2 * frequency * index) / sampleRate) * amplitude
  }
  return samples
}

function clipWithLiveNotes(
  profile: ReturnType<typeof createDefaultProfile>,
  notes: ReturnType<typeof adjustedNote>[],
) {
  return cleanupCapturedClip({
    duration: Math.max(...notes.map((note) => note.start + note.duration), 0),
    frames: [],
    profile,
    events: notes.flatMap((note) => [
      { id: `${note.id}-on`, type: 'noteOn' as const, time: note.start, midi: note.midi, velocity: note.velocity },
      { id: `${note.id}-off`, type: 'noteOff' as const, time: note.start + note.duration, midi: note.midi },
    ]),
  })
}

function adjustedNote(
  id: string,
  start: number,
  duration: number,
  midi: number,
  velocity: number,
  confidence: number,
) {
  return {
    id,
    rawId: id,
    start,
    duration,
    quantizedStart: start,
    quantizedDuration: duration,
    rawMidi: midi,
    midi,
    rawNoteName: `midi-${midi}`,
    noteName: `midi-${midi}`,
    velocity,
    confidence,
    pitchBends: [0.1],
  }
}

function detectedNote(
  id: string,
  start: number,
  duration: number,
  midi: number,
  velocity: number,
  confidence: number,
) {
  return {
    id,
    start,
    duration,
    midi,
    velocity,
    confidence,
    pitchBends: [0.05],
  }
}
