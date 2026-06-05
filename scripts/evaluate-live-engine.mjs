import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const SAMPLE_RATE = 16_000
const FRAME_SIZE = 1024
const HOP_SIZE = 256
const MIN_HZ = 90
const MAX_HZ = 950
const YIN_THRESHOLD = 0.18
const NOTE_SWITCH_SECONDS = 0.08
const MIN_NOTE_SECONDS = 0.06

const datasetDir = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const debugFile = process.argv
  .find((arg) => arg.startsWith('--file='))
  ?.slice('--file='.length)

if (!datasetDir) {
  throw new Error(
    'Pass a fixture directory. Example: npm run eval:live -- /path/to/samplebank',
  )
}

const files = readdirSync(datasetDir)
  .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
  .filter((file) => !debugFile || file === debugFile)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

if (files.length === 0) {
  throw new Error(`No label JSON files found in ${datasetDir}`)
}

const startedAt = performance.now()
let totalDuration = 0
let totalDecodeMs = 0
let totalDetectMs = 0
let totalTruth = 0
let totalPredicted = 0
let totalCorrect = 0
let totalPitchCorrect = 0
let totalTimingCorrect = 0
const worstFiles = []

for (const jsonFile of files) {
  const jsonPath = path.join(datasetDir, jsonFile)
  const label = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const audioPath = audioPathForLabel(jsonPath)

  const decodeStartedAt = performance.now()
  const samples = decodeAudioToMonoFloat(audioPath)
  const decodeMs = performance.now() - decodeStartedAt

  const detectStartedAt = performance.now()
  const predicted = detectLiveEngineNotes(samples, SAMPLE_RATE)
  const detectMs = performance.now() - detectStartedAt
  const score = scoreNotes(label.notes, predicted)
  const duration = label.durationSeconds ?? samples.length / SAMPLE_RATE

  totalDuration += duration
  totalDecodeMs += decodeMs
  totalDetectMs += detectMs
  totalTruth += label.notes.length
  totalPredicted += predicted.length
  totalCorrect += score.correct
  totalPitchCorrect += score.pitchCorrect
  totalTimingCorrect += score.timingCorrect
  worstFiles.push({
    file: jsonFile,
    gt: label.notes.length,
    predicted: predicted.length,
    accuracy: score.accuracy,
    falseNotes: Math.max(0, predicted.length - score.correct),
  })

  if (debugFile) {
    console.log(
      JSON.stringify(
        {
          file: jsonFile,
          audioPath,
          groundTruth: label.notes.map(compactNote),
          predicted: predicted.map(compactNote),
          score,
        },
        null,
        2,
      ),
    )
  }
}

const elapsedMs = performance.now() - startedAt
const accuracy = totalCorrect / Math.max(totalTruth, totalPredicted, 1)
const recall = totalCorrect / Math.max(totalTruth, 1)
const precision = totalCorrect / Math.max(totalPredicted, 1)

console.log(
  JSON.stringify(
    {
      files: files.length,
      audioSeconds: round(totalDuration),
      groundTruthNotes: totalTruth,
      predictedNotes: totalPredicted,
      accuracy: percent(accuracy),
      recall: percent(recall),
      precision: percent(precision),
      pitchRecall: percent(totalPitchCorrect / Math.max(totalTruth, 1)),
      timingRecall: percent(totalTimingCorrect / Math.max(totalTruth, 1)),
      falseNotes: Math.max(0, totalPredicted - totalCorrect),
      detectSeconds: round(totalDetectMs / 1000),
      decodeSeconds: round(totalDecodeMs / 1000),
      wallSeconds: round(elapsedMs / 1000),
      detectRealtimeRatio: round(totalDetectMs / 1000 / totalDuration),
      totalRealtimeRatio: round((totalDecodeMs + totalDetectMs) / 1000 / totalDuration),
      worstFiles: worstFiles
        .sort((a, b) => a.accuracy - b.accuracy)
        .slice(0, 12)
        .map((file) => ({ ...file, accuracy: percent(file.accuracy) })),
    },
    null,
    2,
  ),
)

function detectLiveEngineNotes(samples, sampleRate) {
  const threshold = adaptiveRmsThreshold(samples)
  const state = {
    activeMidi: null,
    activeStart: 0,
    activeFrames: [],
    pendingMidi: null,
    pendingStart: 0,
  }
  const notes = []

  for (
    let startSample = 0;
    startSample + FRAME_SIZE <= samples.length;
    startSample += HOP_SIZE
  ) {
    const frame = samples.subarray(startSample, startSample + FRAME_SIZE)
    const time = startSample / sampleRate
    const rmsValue = rms(frame)
    const estimate =
      rmsValue >= threshold.rms
        ? estimatePitchYin(frame, sampleRate, threshold.yin)
        : null
    const lockedMidi = estimate ? Math.round(frequencyToMidi(estimate.frequency)) : null

    if (lockedMidi === null) {
      closeActiveNote(notes, state, time)
      continue
    }

    if (state.activeMidi === null) {
      state.activeMidi = lockedMidi
      state.activeStart = time
      state.activeFrames = [{ midi: frequencyToMidi(estimate.frequency), rms: rmsValue }]
      continue
    }

    if (lockedMidi === state.activeMidi) {
      state.pendingMidi = null
      state.activeFrames.push({ midi: frequencyToMidi(estimate.frequency), rms: rmsValue })
      continue
    }

    if (state.pendingMidi !== lockedMidi) {
      state.pendingMidi = lockedMidi
      state.pendingStart = time
      continue
    }

    if (time - state.pendingStart >= NOTE_SWITCH_SECONDS) {
      closeActiveNote(notes, state, time)
      state.activeMidi = lockedMidi
      state.activeStart = time
      state.activeFrames = [{ midi: frequencyToMidi(estimate.frequency), rms: rmsValue }]
      state.pendingMidi = null
    }
  }

  closeActiveNote(notes, state, samples.length / sampleRate)
  return notes.map((note, index) => ({ ...note, id: `live-${index}` }))
}

function closeActiveNote(notes, state, time) {
  if (state.activeMidi === null) {
    return
  }

  const duration = time - state.activeStart
  if (duration >= MIN_NOTE_SECONDS) {
    const weight = state.activeFrames.reduce((sum, frame) => sum + frame.rms, 0)
    const midi =
      state.activeFrames.reduce((sum, frame) => sum + frame.midi * frame.rms, 0) /
      Math.max(1e-6, weight)
    notes.push({
      start: state.activeStart,
      duration,
      midi,
      velocity: Math.max(0.1, Math.min(1, Math.max(...state.activeFrames.map((frame) => frame.rms)) * 8)),
      pitchBends: [],
      confidence: 0.85,
    })
  }

  state.activeMidi = null
  state.pendingMidi = null
  state.activeFrames = []
}

function estimatePitchYin(samples, sampleRate, threshold) {
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  const maxTau = Math.min(samples.length - 2, Math.ceil(sampleRate / MIN_HZ))
  const difference = new Float64Array(maxTau + 1)

  for (let tau = minTau; tau <= maxTau; tau += 1) {
    let sum = 0
    for (let index = 0; index + tau < samples.length; index += 1) {
      const delta = samples[index] - samples[index + tau]
      sum += delta * delta
    }
    difference[tau] = sum
  }

  let runningTotal = 0
  const cumulative = new Float64Array(maxTau + 1)
  for (let tau = 1; tau <= maxTau; tau += 1) {
    runningTotal += difference[tau]
    cumulative[tau] = runningTotal > 0 ? (difference[tau] * tau) / runningTotal : 1
  }

  let bestTau = -1
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (cumulative[tau] < threshold) {
      bestTau = tau
      while (bestTau + 1 <= maxTau && cumulative[bestTau + 1] < cumulative[bestTau]) {
        bestTau += 1
      }
      break
    }
  }

  if (bestTau < 0) {
    return null
  }

  return { frequency: sampleRate / parabolicTau(cumulative, bestTau) }
}

function adaptiveRmsThreshold(samples) {
  const values = []
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    values.push(rms(samples.subarray(start, start + FRAME_SIZE)))
  }
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return { rms: 1, yin: YIN_THRESHOLD }
  }
  const low = percentile(sorted, 0.2)
  const mid = percentile(sorted, 0.5)
  return {
    rms: Math.max(0.002, Math.min(low * 3.2, mid * 0.45)),
    yin: YIN_THRESHOLD,
  }
}

function scoreNotes(groundTruth, predicted) {
  const used = new Set()
  let correct = 0
  let pitchCorrect = 0
  let timingCorrect = 0

  for (const truth of groundTruth) {
    let bestIndex = -1
    let bestOverlap = 0
    for (let index = 0; index < predicted.length; index += 1) {
      if (used.has(index)) {
        continue
      }
      const overlap = overlapSeconds(truth, predicted[index])
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestIndex = index
      }
    }

    if (bestIndex < 0) {
      continue
    }

    const match = predicted[bestIndex]
    used.add(bestIndex)
    const pitchMatches = Math.round(match.midi) === Math.round(truth.midi)
    const timingMatches =
      bestOverlap / Math.max(0.001, truth.duration) >= 0.5 ||
      Math.abs(match.start - truth.start) <= 0.08

    if (pitchMatches) {
      pitchCorrect += 1
    }
    if (timingMatches) {
      timingCorrect += 1
    }
    if (pitchMatches && timingMatches) {
      correct += 1
    }
  }

  return {
    correct,
    pitchCorrect,
    timingCorrect,
    accuracy: correct / Math.max(groundTruth.length, predicted.length, 1),
  }
}

function audioPathForLabel(jsonPath) {
  const base = jsonPath.replace(/\.json$/, '')
  for (const extension of ['.wav', '.mp3']) {
    if (existsSync(`${base}${extension}`)) {
      return `${base}${extension}`
    }
  }
  throw new Error(`No .wav or .mp3 audio found for ${jsonPath}`)
}

function decodeAudioToMonoFloat(audioPath) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      audioPath,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 },
  )

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${audioPath}: ${result.stderr.toString('utf8')}`)
  }

  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT,
  )
}

function overlapSeconds(first, second) {
  const start = Math.max(first.start, second.start)
  const end = Math.min(first.start + first.duration, second.start + second.duration)
  return Math.max(0, end - start)
}

function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440)
}

function parabolicTau(values, tau) {
  if (tau <= 0 || tau >= values.length - 1) {
    return tau
  }
  const left = values[tau - 1]
  const center = values[tau]
  const right = values[tau + 1]
  const denominator = left - 2 * center + right
  return Math.abs(denominator) < 1e-9 ? tau : tau + (left - right) / (2 * denominator)
}

function rms(samples) {
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index]
  }
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function percentile(sorted, percentileValue) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * percentileValue)),
  )
  return sorted[index]
}

function compactNote(note) {
  return {
    start: round(note.start),
    duration: round(note.duration),
    midi: round(note.midi),
  }
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`
}
