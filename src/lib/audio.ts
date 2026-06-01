const TARGET_SAMPLE_RATE = 22050

type WindowWithAudioPrefixes = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
    webkitOfflineAudioContext?: typeof OfflineAudioContext
  }

export interface AudioSource {
  buffer: AudioBuffer
  url: string
  name: string
  duration: number
}

export function getAudioContext(): AudioContext {
  const AudioContextCtor =
    window.AudioContext ??
    (window as WindowWithAudioPrefixes).webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error('This browser does not support Web Audio.')
  }

  return new AudioContextCtor()
}

export async function decodeBlobToAudioSource(
  blob: Blob,
  name: string,
): Promise<AudioSource> {
  const context = getAudioContext()
  const arrayBuffer = await blob.arrayBuffer()
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0))

  return {
    buffer: decoded,
    duration: decoded.duration,
    name,
    url: URL.createObjectURL(blob),
  }
}

export async function decodeFileToAudioSource(
  file: File,
): Promise<AudioSource> {
  return decodeBlobToAudioSource(file, file.name)
}

export async function resampleToBasicPitchInput(
  audioBuffer: AudioBuffer,
): Promise<Float32Array> {
  const offlineBuffer = await renderMonoBuffer(audioBuffer, TARGET_SAMPLE_RATE)
  return applyVocalBandLimit(
    offlineBuffer.getChannelData(0).slice(),
    TARGET_SAMPLE_RATE,
  )
}

export function applyVocalBandLimit(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  const highPassed = applyBiquad(samples, sampleRate, 'highpass', 85, 0.707)
  return applyBiquad(highPassed, sampleRate, 'lowpass', 1150, 0.707)
}

async function renderMonoBuffer(
  audioBuffer: AudioBuffer,
  sampleRate: number,
): Promise<AudioBuffer> {
  const OfflineAudioContextCtor =
    window.OfflineAudioContext ??
    (window as WindowWithAudioPrefixes).webkitOfflineAudioContext

  if (!OfflineAudioContextCtor) {
    throw new Error('This browser does not support offline audio rendering.')
  }

  const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * sampleRate))
  const offlineContext = new OfflineAudioContextCtor(1, frameCount, sampleRate)
  const monoBuffer = offlineContext.createBuffer(
    1,
    audioBuffer.length,
    audioBuffer.sampleRate,
  )
  const monoChannel = monoBuffer.getChannelData(0)

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const sourceChannel = audioBuffer.getChannelData(channel)
    for (let index = 0; index < sourceChannel.length; index += 1) {
      monoChannel[index] += sourceChannel[index] / audioBuffer.numberOfChannels
    }
  }

  const source = offlineContext.createBufferSource()
  source.buffer = monoBuffer
  source.connect(offlineContext.destination)
  source.start(0)

  return offlineContext.startRendering()
}

function applyBiquad(
  samples: Float32Array,
  sampleRate: number,
  type: 'highpass' | 'lowpass',
  frequency: number,
  q: number,
): Float32Array {
  const omega = (2 * Math.PI * frequency) / sampleRate
  const sin = Math.sin(omega)
  const cos = Math.cos(omega)
  const alpha = sin / (2 * q)
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let b0: number
  let b1: number
  let b2: number

  if (type === 'highpass') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
  } else {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
  }

  b0 /= a0
  b1 /= a0
  b2 /= a0
  const normalizedA1 = a1 / a0
  const normalizedA2 = a2 / a0
  const output = new Float32Array(samples.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0

  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index]
    const y0 =
      b0 * x0 + b1 * x1 + b2 * x2 - normalizedA1 * y1 - normalizedA2 * y2
    output[index] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }

  return output
}
