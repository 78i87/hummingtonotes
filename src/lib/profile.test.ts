import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDefaultProfile,
  loadProfile,
  normalizeProfile,
  saveProfile,
} from './profile'

describe('vocal profile persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('creates a complete default profile', () => {
    const profile = createDefaultProfile()

    expect(profile.triggers).toHaveLength(4)
    expect(profile.ccMappings.map((mapping) => mapping.source)).toContain('envelope')
    expect(profile.pitch.bendMode).toBe('intellibend')
    expect(profile.pitch.inputLevel).toBe(1)
    expect(profile.pitch.stickiness).toBe(0.5)
  })

  it('normalizes partial saved profile data', () => {
    const profile = normalizeProfile({
      name: 'Gig',
      pitch: { key: 'D' } as never,
    })

    expect(profile.name).toBe('Gig')
    expect(profile.pitch.key).toBe('D')
    expect(profile.pitch.scale).toBe('major')
    expect(profile.pitch.inputLevel).toBe(1)
    expect(profile.pitch.stickiness).toBe(0.5)
    expect(profile.triggers).toHaveLength(4)
  })

  it('saves and loads the local profile', () => {
    const profile = createDefaultProfile()
    saveProfile({ ...profile, name: 'Saved Voice' })

    expect(loadProfile().name).toBe('Saved Voice')
  })
})
