# Humming To Notes

Local-first browser app that turns hummed, `la-la`, or `du-du` vocal melodies into editable notes and MIDI.

The app records or imports audio, runs Spotify Basic Pitch locally in the browser, applies vocal melody cleanup for syllable fragments, lets you correct key/scale/rhythm, previews the result as piano, and exports MIDI.

## Features

- Microphone recording and audio file upload.
- Local Basic Pitch transcription with bundled model assets.
- Vocal articulation cleanup for repeated same-pitch syllables.
- Key/scale suggestion with manual override.
- Pitch correction, transposition, BPM, and rhythm quantization controls.
- Raw versus corrected timeline.
- Editable note table.
- Piano playback of the corrected MIDI.
- MIDI export.

## Local Development

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Scripts

```bash
npm test
npm run lint
npm run build
```

## Privacy

Audio is processed in the browser. The Basic Pitch model files are served from `public/basic-pitch/`; the app does not upload recordings to a backend.

## Third-Party Notices

Transcription is powered by Spotify Basic Pitch and runs locally in the browser. Spotify is not affiliated with or endorsing this app.

License notices for direct runtime dependencies are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Notes

- Best results come from one clear melody line at a time.
- Browser microphone access requires HTTPS in production. Localhost works for development.
- The transcription bundle is intentionally lazy-loaded when analysis starts because TensorFlow.js and Basic Pitch are large.
