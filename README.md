# Auto Multi-Cam Edit (Nexus)

An Adobe Premiere Pro CEP extension that automatically edits multi-camera podcast/interview footage by analyzing mic audio and switching between cameras based on who's speaking.

## What It Does

Feed it a synced multi-cam sequence (multiple cameras + individual lavalier mics), and it will:

- Analyze every mic track to detect who's speaking when
- Apply razor cuts and switch to the active speaker's camera
- Intelligently cut between cameras like a documentary editor
- Add brief "reaction cutaways" showing the listener
- Remove awkward silence gaps

## The 7-Layer Conversation-Aware Engine

1. **Noise floor calibration** — per-track dynamic threshold
2. **Speech segment building** — PRIMARY / SHORT / REACTION classification
3. **Conversation state machine** — SPEAKING / SILENCE / OVERLAP / REACTION
4. **Tempo detection** — FAST / NORMAL / CALM zones
5. **Weighted camera selection** — with memory penalty and editorial bias
6. **Silence gap removal** — ripple delete with sequence protection
7. **Sequence protection** — clone before edit

## Editorial Intelligence

- **Reaction Cutaway**: Brief (0.5–2s, configurable) glimpses of the non-speaking person, then auto-return to the active speaker
- **Wide Cutaway frequency**: Per-speaker slider controls how often the wide shot appears
- **High-energy hold**: Stays on the speaker during powerful moments
- **Adaptive monologue threshold**: Animated speakers get longer uninterrupted holds
- **Natural pause alignment**: Cuts land on silence boundaries, not mid-sentence
- **Same-camera guard**: No meaningless razor marks where the camera doesn't change
- **Track disable safety guard**: Prevents any video track from being 100% hidden

## Requirements

- Adobe Premiere Pro (tested on 2023+)
- Windows (macOS untested)
- Multi-cam sequence with one audio track per speaker (e.g., lavalier mics)

## Installation

1. Copy `com.autocam.multicamedit/` to your CEP extensions folder:
   - Windows: `%APPDATA%\Adobe\CEP\extensions\`
   - macOS: `~/Library/Application Support/Adobe/CEP/extensions/`
2. Enable unsigned extensions in the registry / plist (one-time):
   - Windows: `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` → add String `PlayerDebugMode` = `1`
3. Restart Premiere Pro
4. Open via `Window → Extensions → Auto Multi-Cam Edit`

## Usage

1. Open a synced multi-cam sequence in Premiere Pro
2. Click **Scan Active Sequence**
3. Map each audio track (mic) to its primary camera
4. Set the **Wide Shot Camera Track** (neutral angle showing all speakers)
5. Adjust per-speaker **Wide Freq%** slider (0–50%) to control how often wide appears
6. Click **Analyze Audio** — review cuts in the preview table
7. Click **Apply Cuts to Timeline** (protects original by duplicating the sequence)
8. Optional: Click **Remove Silence Gaps** to ripple-delete awkward pauses

## Project Structure

```
com.autocam.multicamedit/
├── CSXS/manifest.xml            # CEP extension manifest
├── bin/ffmpeg.exe               # Bundled FFmpeg for audio extraction
├── client/                      # Panel UI (HTML/CSS/JS)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── main.js              # UI orchestration + ExtendScript bridge
│       ├── audio-analyzer.js    # The 7-layer conversation engine (Node.js)
│       ├── CSInterface.js       # Adobe CEP API
│       └── lib/json2.js
└── host/                        # ExtendScript (runs in Premiere)
    ├── index.jsx
    ├── sequence-reader.jsx      # Scan timeline, read clips
    └── multicam-editor.jsx      # Razor cuts + enable/disable tracks
```

## License

Personal / experimental project. No warranty.
