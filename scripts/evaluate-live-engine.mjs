import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'vite'

const SAMPLE_RATE = 16_000
const FRAME_SIZE = 1024
const HOP_SIZE = 256

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
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

const engine = await loadLiveEngine()
const startedAt = performance.now()
let totalDuration = 0
let totalDecodeMs = 0
let totalDetectMs = 0
let totalTruth = 0
let totalPredicted = 0
let totalCorrect = 0
let totalPitchCorrect = 0
let totalTimingCorrect = 0
let totalOctaveErrors = 0
let totalSplitNotes = 0
const worstFiles = []

for (const jsonFile of files) {
  const jsonPath = path.join(datasetDir, jsonFile)
  const label = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const audioPath = audioPathForLabel(jsonPath)

  const decodeStartedAt = performance.now()
  const samples = decodeAudioToMonoFloat(audioPath)
  const decodeMs = performance.now() - decodeStartedAt

  const detectStartedAt = performance.now()
  const profile = createBenchmarkProfile(
    autoCalibrationFromSamples(samples, engine.createDefaultCalibration()),
  )
  const clip = engine.analyzeOfflineLiveClip(samples, SAMPLE_RATE, profile)
  const predicted = clip.cleanedNotes
  const detectMs = performance.now() - detectStartedAt
  const score = scoreNotes(label.notes, predicted)
  const splitNotes = splitNoteCount(label.notes, predicted)
  const duration = label.durationSeconds ?? samples.length / SAMPLE_RATE

  totalDuration += duration
  totalDecodeMs += decodeMs
  totalDetectMs += detectMs
  totalTruth += label.notes.length
  totalPredicted += predicted.length
  totalCorrect += score.correct
  totalPitchCorrect += score.pitchCorrect
  totalTimingCorrect += score.timingCorrect
  totalOctaveErrors += score.octaveErrors
  totalSplitNotes += splitNotes
  worstFiles.push({
    file: jsonFile,
    gt: label.notes.length,
    predicted: predicted.length,
    accuracy: score.accuracy,
    falseNotes: Math.max(0, predicted.length - score.correct),
    octaveErrors: score.octaveErrors,
    splitNotes,
  })

  if (debugFile) {
    console.log(
      JSON.stringify(
        {
          file: jsonFile,
          audioPath,
          calibration: profile.calibration,
          groundTruth: label.notes.map(compactNote),
          predicted: predicted.map(compactNote),
          suggestedKey: clip.suggestedKey,
          score: {
            ...score,
            splitNotes,
          },
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
      octaveErrors: totalOctaveErrors,
      splitNotes: totalSplitNotes,
      splitNoteRate: percent(totalSplitNotes / Math.max(totalTruth, 1)),
      detectSeconds: round(totalDetectMs / 1000),
      decodeSeconds: round(totalDecodeMs / 1000),
      wallSeconds: round(elapsedMs / 1000),
      detectRealtimeRatio: round(totalDetectMs / 1000 / totalDuration),
      totalRealtimeRatio: round((totalDecodeMs + totalDetectMs) / 1000 / totalDuration),
      worstFiles: worstFiles
        .sort(
          (a, b) =>
            a.accuracy - b.accuracy ||
            b.falseNotes - a.falseNotes ||
            b.octaveErrors - a.octaveErrors,
        )
        .slice(0, 12)
        .map((file) => ({ ...file, accuracy: percent(file.accuracy) })),
    },
    null,
    2,
  ),
)

async function loadLiveEngine() {
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'music-copilot-live-engine-'))
  try {
    await build({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      build: {
        emptyOutDir: true,
        outDir: bundleDir,
        target: 'node24',
        lib: {
          entry: path.join(projectRoot, 'src/lib/liveEngine.ts'),
          formats: ['es'],
          fileName: 'live-engine',
        },
      },
    })
    const bundleFile = readdirSync(bundleDir).find((file) => file.endsWith('.mjs') || file.endsWith('.js'))
    if (!bundleFile) {
      throw new Error(`Vite did not write a live engine bundle to ${bundleDir}`)
    }

    return await import(pathToFileURL(path.join(bundleDir, bundleFile)).href)
  } finally {
    process.once('exit', () => {
      rmSync(bundleDir, { force: true, recursive: true })
    })
  }
}

function createBenchmarkProfile(calibration) {
  return {
    id: 'benchmark',
    name: 'Benchmark Voice',
    updatedAt: Date.now(),
    calibration,
    pitch: {
      key: 'C',
      scale: 'major',
      keyLock: false,
      bendMode: 'intellibend',
      inputLevel: 1,
      stickiness: 0.6,
      transpose: 0,
      octave: 0,
    },
    chords: {
      enabled: false,
      preset: 'majorTriad',
      voicing: 'cluster',
      holdSeconds: 0.6,
    },
    triggers: [],
    ccMappings: [],
    ccSmoothing: 0.7,
  }
}

function autoCalibrationFromSamples(samples, fallback) {
  const frameRms = []
  for (
    let startSample = 0;
    startSample + FRAME_SIZE <= samples.length;
    startSample += HOP_SIZE
  ) {
    frameRms.push(rms(samples.subarray(startSample, startSample + FRAME_SIZE)))
  }

  const sorted = frameRms.filter((value) => value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return fallback
  }

  const noiseFloorRms = Math.max(0.001, percentile(sorted, 0.15))
  const vocalRms = Math.max(
    percentile(sorted, 0.8),
    average(sorted),
    noiseFloorRms * 6,
  )

  return {
    ...fallback,
    inputLevel: 1,
    noiseFloorRms,
    vocalRms,
    rmsThreshold: Math.max(noiseFloorRms * 2.4, vocalRms * 0.12, 0.008),
    minMidi: 36,
    maxMidi: 88,
  }
}

function scoreNotes(groundTruth, predicted) {
  const used = new Set()
  let correct = 0
  let pitchCorrect = 0
  let timingCorrect = 0
  let octaveErrors = 0

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
    const truthMidi = Math.round(truth.actualMidi ?? truth.midi)
    const predictedMidi = Math.round(match.midi)
    const pitchMatches = predictedMidi === truthMidi
    const timingMatches =
      bestOverlap / Math.max(0.001, truth.duration) >= 0.5 ||
      Math.abs(match.start - truth.start) <= 0.08
    const pitchDistance = Math.abs(predictedMidi - truthMidi)

    if (pitchMatches) {
      pitchCorrect += 1
    } else if (Math.abs(pitchDistance - 12) <= 1) {
      octaveErrors += 1
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
    octaveErrors,
    accuracy: correct / Math.max(groundTruth.length, predicted.length, 1),
  }
}

function splitNoteCount(groundTruth, predicted) {
  return groundTruth.reduce((sum, truth) => {
    const truthMidi = Math.round(truth.actualMidi ?? truth.midi)
    const overlaps = predicted.filter((note) => {
      const overlap = overlapSeconds(truth, note)
      return (
        Math.round(note.midi) === truthMidi &&
        overlap / Math.max(0.001, truth.duration) >= 0.15
      )
    })
    return sum + Math.max(0, overlaps.length - 1)
  }, 0)
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
  return sorted[index] ?? 0
}

function average(values) {
  if (values.length === 0) {
    return 0
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function compactNote(note) {
  return {
    start: round(note.start),
    duration: round(note.duration),
    midi: round(note.actualMidi ?? note.midi),
  }
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`
}
