# Sigma Audio

A modern, browser-based audio editor and converter. It supports:

- Instant BPM, musical key, scale, sample-rate, and source bit-depth analysis
- Seekable processed waveform preview
- Varispeed from 0.5×–1.5×, with the natural matching pitch change
- Independent ±12-semitone key/pitch shifting and target-key selection
- A 10-band equalizer with Flat, Bass Boost, Club Punch, Vocal Clarity, Warm, and Bright presets
- WAV, MP3, OGG Vorbis, FLAC, M4A/AAC, and AIFF output
- Sample-rate conversion from 44.1–192 kHz and 16/24/32-bit lossless output
- Channel selection, editable output filenames, and direct download

Analysis, preview processing, and final rendering run locally in the browser. Files are not uploaded to a server. BPM and key detection are estimates and can vary with rhythmically or harmonically ambiguous material.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build

```bash
npm run build
```

The production site is written to `dist/`. The build script copies the FFmpeg core and WebAssembly files into the site so conversions do not rely on a third-party CDN.

## Browser notes

- Serve the project through a local HTTP server; opening `index.html` directly as a `file://` URL will not work with the conversion engine.
- Large audio files require more browser memory. The interface limits files to 500 MB.
- Bit depth applies to lossless PCM/FLAC outputs. Lossy formats use bitrate instead.
