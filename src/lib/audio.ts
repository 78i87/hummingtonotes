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
  return offlineBuffer.getChannelData(0).slice()
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
