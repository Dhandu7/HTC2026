# HTC2026

# VocalEyes

> **Speak with your eyes stay part of the conversation**

VocalEyes is a webcam-only, conversation-first communicator for people who can't speak or use their hands, such as people living with ALS, cerebral palsy or locked-in syndrome. It runs on any laptop with a webcam. The user looks at a suggested reply, and VocalEyes speaks it aloud. Typing is the mechanism. The conversation is the product.

## The problem

Dedicated eye-tracking communication devices cost thousands of dollars and still make people type one letter at a time. A conversation at that speed loses its jokes, its timing and its warmth. People drift away from friends and family, and isolation is itself a health risk.

## What VocalEyes does

- **Webcam-only gaze control.** MediaPipe face and iris landmarks, with a 9-point calibration. Gaze tracking runs on-device, so no video leaves the laptop.
- **Built for imperfect tracking.** Large targets, dwell selection (~700 ms) and a prediction-first layout, so a few degrees of error doesn't break the experience.
- **Conversation-first suggestions.** Claude proposes replies based on who the user is talking to and the topic, so most messages take one selection.
- **Learns your voice.** Your own phrases, jokes and the names of the people you love get surfaced first over time.
- **Hears the other side.** The partner's speech is transcribed live so the user can follow the conversation. Replies are spoken aloud with text-to-speech.
- **Local support.** Keenable surfaces real accessible activities and ALS support groups in Calgary.

## Measured results

| Metric | Result |
|---|---|
| Target-hit rate (6-button layout, after calibration) | **[XX]%** |
| Average gaze error after calibration | **[X.X]°** |
| Messages per minute, with suggestions vs. letter-by-letter | **[X] vs. [X]** |

*Measured on [number] testers, [lighting conditions], [laptop model].*

## How it works

```
Webcam → Gaze module (in browser) → {x, y, confidence}
                                         ↓
Partner mic → speech-to-text → Conversation UI ← gaze selects a suggestion
                                    ↓                    ↓
                       POST /suggest (Claude)     Text-to-speech
                                    ↓
              Backend (phrases, messages, mood) → Family dashboard → n8n alerts
```

| Layer | Tech |
|---|---|
| Gaze tracking | MediaPipe Face Landmarker, iris landmarks, One Euro smoothing |
| Frontend | [React / Vite] |
| Suggestions | Claude API |
| Speech | Web Speech API (partner transcription), browser TTS |
| Backend | [AWS / Supabase] |
| Automation | n8n |
| Local resources | Keenable |

## Getting started

```bash
git clone [repo-url]
cd gazetype
cp .env.example .env     # add your API keys
npm install
npm run dev
```

Open the app in Chrome, allow webcam access, and complete the 9-point calibration. Sit about 50–70 cm from the screen in even lighting for the best results.

**Fallbacks:** if gaze tracking is unreliable in your lighting, switch to pointer mode or the keyboard mode in settings. The conversation engine works the same way in both.

## Privacy and safety

- Video is processed in the browser and never uploaded.
- Only the text of selected messages and the user's learned phrases are stored.
- VocalEyes is a communication aid, not a medical device.

## Roadmap

- Swipe-style dwell-free gaze typing
- Multi-language support
- Caregiver mode and emergency phrases
- Validation with ALS clinicians and users

## Team

| Name | Role |
|---|---|
| [Name] | Gaze tracking |
| [Name] | Gaze UI |
| [Name] | Conversation engine |
| [Name] | Family loop and local impact |
| [Name] | Backend and integration |

Built at [Hackathon name], [Nov 2026].

## License

[MIT]
