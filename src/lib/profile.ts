import { createDefaultCalibration } from './liveEngine'
import type { CcMapping, TriggerSlot, VocalProfile } from './types'

const STORAGE_KEY = 'music-copilot-vocal-profile-v1'

export function createDefaultProfile(): VocalProfile {
  return {
    id: 'default',
    name: 'Studio Voice',
    updatedAt: Date.now(),
    calibration: createDefaultCalibration(),
    pitch: {
      key: 'C',
      scale: 'major',
      keyLock: true,
      bendMode: 'intellibend',
      inputLevel: 1,
      stickiness: 0.5,
      transpose: 0,
      octave: 0,
    },
    chords: {
      enabled: false,
      preset: 'majorTriad',
      voicing: 'cluster',
      holdSeconds: 0.6,
    },
    triggers: createDefaultTriggerSlots(),
    ccMappings: createDefaultCcMappings(),
    ccSmoothing: 0.7,
  }
}

export function createDefaultTriggerSlots(): TriggerSlot[] {
  return [
    { id: 'kick', label: 'Kick', midi: 36, enabled: true, examples: [] },
    { id: 'snare', label: 'Snare', midi: 38, enabled: true, examples: [] },
    { id: 'hat', label: 'Hat', midi: 42, enabled: true, examples: [] },
    { id: 'clap', label: 'Clap', midi: 39, enabled: true, examples: [] },
  ]
}

export function createDefaultCcMappings(): CcMapping[] {
  return [
    { id: 'env', label: 'Envelope', source: 'envelope', cc: 11, enabled: true },
    { id: 'ah', label: 'Ah', source: 'ah', cc: 74, enabled: true },
    { id: 'ee', label: 'Ee', source: 'ee', cc: 71, enabled: true },
    { id: 'oo', label: 'Oo', source: 'oo', cc: 1, enabled: true },
  ]
}

export function loadProfile(): VocalProfile {
  if (typeof window === 'undefined') {
    return createDefaultProfile()
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return createDefaultProfile()
  }

  try {
    return normalizeProfile(JSON.parse(raw) as Partial<VocalProfile>)
  } catch {
    return createDefaultProfile()
  }
}

export function saveProfile(profile: VocalProfile): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...profile,
      updatedAt: Date.now(),
    }),
  )
}

export function normalizeProfile(candidate: Partial<VocalProfile>): VocalProfile {
  const fallback = createDefaultProfile()

  return {
    ...fallback,
    ...candidate,
    calibration: {
      ...fallback.calibration,
      ...candidate.calibration,
    },
    pitch: {
      ...fallback.pitch,
      ...candidate.pitch,
    },
    chords: {
      ...fallback.chords,
      ...candidate.chords,
    },
    triggers:
      candidate.triggers && candidate.triggers.length > 0
        ? candidate.triggers.map((slot, index) => ({
            ...fallback.triggers[index % fallback.triggers.length],
            ...slot,
            examples: slot.examples ?? [],
          }))
        : fallback.triggers,
    ccMappings:
      candidate.ccMappings && candidate.ccMappings.length > 0
        ? candidate.ccMappings.map((mapping, index) => ({
            ...fallback.ccMappings[index % fallback.ccMappings.length],
            ...mapping,
          }))
        : fallback.ccMappings,
  }
}
