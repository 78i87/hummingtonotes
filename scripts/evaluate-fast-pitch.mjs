import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const SAMPLE_RATE = 16_000
const FRAME_SIZE = 1024
const HOP_SIZE = 256
const MIN_HZ = 150
const MAX_HZ = 850
const MIN_NOTE_SECONDS = 0.07
const SAME_NOTE_GAP_SECONDS = 0.025
const DIFFERENT_NOTE_GAP_SECONDS = 0.045
const YIN_THRESHOLD = 0.18

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const datasetDir = positionalArgs[0] ?? process.env.HUMMING_SAMPLEBANK_DIR
const debugFile = process.argv
  .find((arg) => arg.startsWith('--file='))
  ?.slice('--file='.length)
let lastDetectionDebug = null

if (!datasetDir) {
  throw new Error(
    'Pass a dataset directory or set HUMMING_SAMPLEBANK_DIR. Example: npm run eval:samplebank -- /path/to/samplebank',
  )
}

const startedAt = performance.now()
const files = readdirSync(datasetDir)
  .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
  .filter((file) => !debugFile || file === debugFile)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

if (files.length === 0) {
  throw new Error(`No JSON labels found in ${datasetDir}`)
}

let totalDuration = 0
let totalDecodeMs = 0
let totalDetectMs = 0
let totalGtNotes = 0
let totalPredNotes = 0
let totalCorrect = 0
let totalPitchCorrect = 0
let totalTimingCorrect = 0
let worstFiles = []
const noiseGroups = new Map()

for (const jsonFile of files) {
  const jsonPath = path.join(datasetDir, jsonFile)
  const label = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const mp3Path = jsonPath.replace(/\.json$/, '.mp3')

  const decodeStart = performance.now()
  const samples = decodeMp3ToMonoFloat(mp3Path)
  const decodeMs = performance.now() - decodeStart

  const detectStart = performance.now()
  const predicted = detectVocalNotes(samples, SAMPLE_RATE)
  const detectMs = performance.now() - detectStart

  const score = scoreNotes(label.notes, predicted)
  const duration = label.durationSeconds ?? samples.length / SAMPLE_RATE

  totalDuration += duration
  totalDecodeMs += decodeMs
  totalDetectMs += detectMs
  totalGtNotes += label.notes.length
  totalPredNotes += predicted.length
  totalCorrect += score.correct
  totalPitchCorrect += score.pitchCorrect
  totalTimingCorrect += score.timingCorrect

  worstFiles.push({
    file: jsonFile,
    accuracy: score.accuracy,
    gt: label.notes.length,
    predicted: predicted.length,
    correct: score.correct,
    noiseDb: label.params?.noiseDb ?? 'none',
    preset: label.params?.preset ?? 'unknown',
  })
  addGroupScore(noiseGroups, label.params?.noiseDb ?? 'none', label, predicted, score)

  if (debugFile) {
    console.log(
      JSON.stringify(
        {
          file: jsonFile,
          params: label.params,
          groundTruth: label.notes.map(compactNote),
          rawDetected: lastDetectionDebug?.rawNotes.map(compactNote),
          splitDetected: lastDetectionDebug?.splitNotes.map(compactNote),
          predicted: predicted.map(compactNote),
          score,
        },
        null,
        2,
      ),
    )
  }
}

worstFiles = worstFiles.sort((a, b) => a.accuracy - b.accuracy).slice(0, 12)

const elapsedMs = performance.now() - startedAt
const accuracy = totalCorrect / Math.max(totalGtNotes, totalPredNotes, 1)
const recall = totalCorrect / Math.max(totalGtNotes, 1)
const precision = totalCorrect / Math.max(totalPredNotes, 1)
const pitchRecall = totalPitchCorrect / Math.max(totalGtNotes, 1)
const timingRecall = totalTimingCorrect / Math.max(totalGtNotes, 1)
const detectRatio = totalDetectMs / 1000 / totalDuration
const totalRatio = (totalDecodeMs + totalDetectMs) / 1000 / totalDuration

console.log(
  JSON.stringify(
    {
      files: files.length,
      audioSeconds: round(totalDuration),
      groundTruthNotes: totalGtNotes,
      predictedNotes: totalPredNotes,
      accuracy: percent(accuracy),
      recall: percent(recall),
      precision: percent(precision),
      pitchRecall: percent(pitchRecall),
      timingRecall: percent(timingRecall),
      detectSeconds: round(totalDetectMs / 1000),
      decodeSeconds: round(totalDecodeMs / 1000),
      wallSeconds: round(elapsedMs / 1000),
      detectRealtimeRatio: round(detectRatio, 4),
      totalRealtimeRatio: round(totalRatio, 4),
      byNoiseDb: summarizeGroups(noiseGroups),
      worstFiles,
    },
    null,
    2,
  ),
)

function detectVocalNotes(input, sampleRate) {
  const filtered = bandLimit(input, sampleRate)
  const rmsFrames = frameRms(filtered)
  const threshold = adaptiveRmsThreshold(rmsFrames)
  const pitchFrames = []

  for (
    let startSample = 0, frameIndex = 0;
    startSample + FRAME_SIZE <= filtered.length;
    startSample += HOP_SIZE, frameIndex += 1
  ) {
    const rms = rmsFrames[frameIndex] ?? 0
    if (rms < threshold.floor) {
      pitchFrames.push(null)
      continue
    }

    const estimate = estimatePitchYin(filtered, startSample, sampleRate)
    if (!estimate || estimate.yin > threshold.yin) {
      pitchFrames.push(null)
      continue
    }

    const midi = frequencyToMidi(estimate.frequency)
    if (!Number.isFinite(midi)) {
      pitchFrames.push(null)
      continue
    }

    pitchFrames.push({
      time: startSample / sampleRate,
      midi,
      roundedMidi: Math.round(midi),
      rms,
      confidence: Math.max(0, 1 - estimate.yin),
    })
  }

  const smoothed = smoothPitchFrames(pitchFrames)
  const rawNotes = framesToNotes(smoothed, sampleRate)
  const envelope = amplitudeEnvelope(filtered, sampleRate)
  const splitNotes = splitNotesByAmplitudeValleys(rawNotes, envelope)
  lastDetectionDebug = { rawNotes, splitNotes }
  const cleaned = removeIsolatedArtifacts(splitNotes)
  return cleaned.map((note, index) => ({
    ...note,
    id: `fast-${index}`,
  }))
}

function addGroupScore(groups, key, label, predicted, score) {
  const group = groups.get(key) ?? {
    files: 0,
    groundTruthNotes: 0,
    predictedNotes: 0,
    correct: 0,
  }

  group.files += 1
  group.groundTruthNotes += label.notes.length
  group.predictedNotes += predicted.length
  group.correct += score.correct
  groups.set(key, group)
}

function summarizeGroups(groups) {
  return [...groups.entries()]
    .sort(([first], [second]) => {
      if (first === 'none') {
        return 1
      }
      if (second === 'none') {
        return -1
      }
      return Number(first) - Number(second)
    })
    .map(([noiseDb, group]) => ({
      noiseDb,
      files: group.files,
      accuracy: percent(
        group.correct /
          Math.max(group.groundTruthNotes, group.predictedNotes, 1),
      ),
    }))
}

function amplitudeEnvelope(samples, sampleRate) {
  const frameSize = 256
  const hopSize = 128
  const frames = []

  for (
    let startSample = 0;
    startSample + frameSize <= samples.length;
    startSample += hopSize
  ) {
    let sum = 0
    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[startSample + index]
      sum += sample * sample
    }
    frames.push({
      time: startSample / sampleRate,
      end: (startSample + frameSize) / sampleRate,
      rms: Math.sqrt(sum / frameSize),
    })
  }

  return frames
}

function splitNotesByAmplitudeValleys(notes, envelope) {
  return notes.flatMap((note) => splitNoteByAmplitudeValleys(note, envelope))
}

function splitNoteByAmplitudeValleys(note, envelope) {
  if (note.duration < 0.3) {
    return [note]
  }

  const noteEnd = note.start + note.duration
  const frames = envelope.filter(
    (frame) => frame.time >= note.start && frame.end <= noteEnd,
  )
  if (frames.length < 8) {
    return [note]
  }

  const peak = Math.max(...frames.map((frame) => frame.rms))
  const valleyThreshold = peak * 0.35
  let bestGap = null
  let runStart = null
  let runEnd = null

  for (const frame of frames) {
    const canSplitHere =
      frame.time >= note.start + 0.1 &&
      frame.end <= noteEnd - 0.1 &&
      frame.rms <= valleyThreshold

    if (canSplitHere) {
      runStart ??= frame.time
      runEnd = frame.end
      continue
    }

    bestGap = chooseBetterGap(bestGap, runStart, runEnd, note)
    runStart = null
    runEnd = null
  }
  bestGap = chooseBetterGap(bestGap, runStart, runEnd, note)

  if (!bestGap) {
    return [note]
  }

  const first = {
    ...note,
    duration: bestGap.start - note.start,
  }
  const second = {
    ...note,
    id: `${note.id}:split`,
    start: bestGap.end,
    duration: noteEnd - bestGap.end,
  }

  return [
    ...splitNoteByAmplitudeValleys(first, envelope),
    ...splitNoteByAmplitudeValleys(second, envelope),
  ]
}

function chooseBetterGap(bestGap, runStart, runEnd, note) {
  if (runStart === null || runEnd === null) {
    return bestGap
  }

  const duration = runEnd - runStart
  const noteEnd = note.start + note.duration
  if (
    duration < 0.024 ||
    runStart - note.start < 0.1 ||
    noteEnd - runEnd < 0.1
  ) {
    return bestGap
  }

  const gap = { start: runStart, end: runEnd, duration }
  if (!bestGap || gap.duration > bestGap.duration) {
    return gap
  }

  return bestGap
}

function frameRms(samples) {
  const frames = []
  for (
    let startSample = 0;
    startSample + FRAME_SIZE <= samples.length;
    startSample += HOP_SIZE
  ) {
    let sum = 0
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const sample = samples[startSample + index]
      sum += sample * sample
    }
    frames.push(Math.sqrt(sum / FRAME_SIZE))
  }
  return frames
}

function adaptiveRmsThreshold(rmsFrames) {
  const nonZero = rmsFrames.filter((value) => value > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) {
    return { floor: 1, yin: YIN_THRESHOLD }
  }

  const low = percentile(nonZero, 0.2)
  const mid = percentile(nonZero, 0.5)
  const high = percentile(nonZero, 0.95)
  const dynamicRange = high / Math.max(low, 1e-6)
  const floor = Math.max(0.0015, Math.min(low * 2, mid * 0.4, high * 0.05))
  const yin = dynamicRange < 8 ? 0.14 : YIN_THRESHOLD

  return { floor, yin }
}

function estimatePitchYin(samples, startSample, sampleRate) {
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  const maxTau = Math.min(
    FRAME_SIZE - 2,
    Math.ceil(sampleRate / MIN_HZ),
    samples.length - startSample - 2,
  )
  const windowLength = Math.min(FRAME_SIZE - maxTau, maxTau * 6)
  if (windowLength <= maxTau || maxTau <= minTau) {
    return null
  }

  let mean = 0
  for (let index = 0; index < FRAME_SIZE; index += 1) {
    mean += samples[startSample + index]
  }
  mean /= FRAME_SIZE

  const difference = new Float64Array(maxTau + 1)
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0
    for (let index = 0; index < windowLength; index += 1) {
      const delta =
        samples[startSample + index] -
        mean -
        (samples[startSample + index + tau] - mean)
      sum += delta * delta
    }
    difference[tau] = sum
  }

  const cumulativeMean = new Float64Array(maxTau + 1)
  let runningSum = 0

  for (let tau = 1; tau <= maxTau; tau += 1) {
    runningSum += difference[tau]
    if (runningSum <= 0) {
      cumulativeMean[tau] = 1
      continue
    }

    cumulativeMean[tau] = (difference[tau] * tau) / runningSum
  }

  let bestTau = -1
  let bestYin = Number.POSITIVE_INFINITY
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    const yin = cumulativeMean[tau]
    if (tau < minTau) {
      continue
    }

    if (yin < bestYin) {
      bestYin = yin
      bestTau = tau
    }

    if (yin < YIN_THRESHOLD) {
      let localTau = tau
      while (
        localTau + 1 <= maxTau &&
        cumulativeMean[localTau + 1] > 0 &&
        cumulativeMean[localTau + 1] < cumulativeMean[localTau]
      ) {
        localTau += 1
      }
      bestTau = localTau
      bestYin = cumulativeMean[localTau]
      break
    }
  }

  if (bestTau < 0 || !Number.isFinite(bestYin)) {
    return null
  }

  const refinedTau = parabolicTau(bestTau, cumulativeMean)
  return {
    frequency: sampleRate / refinedTau,
    yin: bestYin,
  }
}

function smoothPitchFrames(frames) {
  return frames.map((frame, index) => {
    if (!frame) {
      return null
    }

    const window = []
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighbor = frames[index + offset]
      if (neighbor && Math.abs(neighbor.midi - frame.midi) <= 1.4) {
        window.push(neighbor.midi)
      }
    }

    if (window.length < 2) {
      return frame
    }

    const midi = median(window)
    return {
      ...frame,
      midi,
      roundedMidi: Math.round(midi),
    }
  })
}

function framesToNotes(frames, sampleRate) {
  const notes = []
  let current = null
  const hopSeconds = HOP_SIZE / sampleRate

  for (const frame of frames) {
    if (!frame) {
      if (current) {
        current.missingFrames += 1
      }
      continue
    }

    const frameEnd = frame.time + FRAME_SIZE / sampleRate
    if (!current) {
      current = startNote(frame, frameEnd)
      continue
    }

    const gap = frame.time - current.lastTime
    const currentMidi = current.weightedMidi / Math.max(1e-6, current.weight)
    const samePitch = Math.abs(frame.midi - currentMidi) < 0.85
    const allowedGap = samePitch
      ? SAME_NOTE_GAP_SECONDS
      : DIFFERENT_NOTE_GAP_SECONDS

    if (gap <= allowedGap && samePitch) {
      addFrameToNote(current, frame, frameEnd)
      continue
    }

    pushNote(notes, current, hopSeconds)
    current = startNote(frame, frameEnd)
  }

  if (current) {
    pushNote(notes, current, hopSeconds)
  }

  return notes
}

function startNote(frame, frameEnd) {
  return {
    start: frame.time,
    end: frameEnd,
    lastTime: frame.time,
    roundedMidi: frame.roundedMidi,
    weightedMidi: frame.midi * frame.rms,
    weight: frame.rms,
    midiValues: [frame.midi],
    velocity: frame.rms,
    confidence: frame.confidence,
    frames: 1,
    missingFrames: 0,
  }
}

function addFrameToNote(note, frame, frameEnd) {
  note.end = Math.max(note.end, frameEnd)
  note.lastTime = frame.time
  note.roundedMidi = Math.round(
    (note.weightedMidi + frame.midi * frame.rms) /
      Math.max(1e-6, note.weight + frame.rms),
  )
  note.weightedMidi += frame.midi * frame.rms
  note.weight += frame.rms
  note.midiValues.push(frame.midi)
  note.velocity = Math.max(note.velocity, frame.rms)
  note.confidence += frame.confidence
  note.frames += 1
  note.missingFrames = 0
}

function pushNote(notes, note, hopSeconds) {
  const duration = note.end - note.start
  if (duration < MIN_NOTE_SECONDS || note.frames < 2) {
    return
  }

  notes.push({
    id: `note-${notes.length}`,
    start: Math.max(0, note.start - hopSeconds * 0.5),
    duration: Math.max(MIN_NOTE_SECONDS, duration),
    midi: median(note.midiValues),
    velocity: Math.min(1, note.velocity * 8),
    pitchBends: [],
    confidence: Math.min(1, note.confidence / note.frames),
  })
}

function removeIsolatedArtifacts(notes) {
  return notes.filter((note, index) => {
    if (note.duration >= 0.11 || note.confidence >= 0.9) {
      return true
    }

    const previous = notes[index - 1]
    const next = notes[index + 1]
    const farFromNeighbors =
      (!previous || Math.abs(previous.midi - note.midi) >= 5) &&
      (!next || Math.abs(next.midi - note.midi) >= 5)

    return !farFromNeighbors
  })
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

function overlapSeconds(a, b) {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.start + a.duration, b.start + b.duration)
  return Math.max(0, end - start)
}

function bandLimit(samples, sampleRate) {
  const highPassed = biquad(samples, sampleRate, 'highpass', 85, 0.707)
  return biquad(highPassed, sampleRate, 'lowpass', 1150, 0.707)
}

function biquad(samples, sampleRate, type, frequency, q) {
  const omega = (2 * Math.PI * frequency) / sampleRate
  const sin = Math.sin(omega)
  const cos = Math.cos(omega)
  const alpha = sin / (2 * q)

  let b0
  let b1
  let b2
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha

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
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - normalizedA1 * y1 - normalizedA2 * y2
    output[index] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }

  return output
}

function parabolicTau(tau, values) {
  if (tau <= 1 || tau >= values.length - 1) {
    return tau
  }

  const previous = values[tau - 1]
  const current = values[tau]
  const next = values[tau + 1]
  const denominator = previous - 2 * current + next
  if (Math.abs(denominator) < 1e-12) {
    return tau
  }

  return tau + (previous - next) / (2 * denominator)
}

function decodeMp3ToMonoFloat(filePath) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  )

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed for ${filePath}: ${result.stderr?.toString() ?? ''}`,
    )
  }

  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ).slice()
}

function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440)
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  )
  return sortedValues[index]
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function compactNote(note) {
  return {
    start: round(note.start),
    duration: round(note.duration),
    midi: round(note.midi, 2),
    rounded: Math.round(note.midi),
    confidence:
      typeof note.confidence === 'number' ? round(note.confidence, 3) : undefined,
  }
}
