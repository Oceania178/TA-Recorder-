# TA Call Recorder app — plan

Triet 29/10/2026: build the desktop app, Steps 0 → 2 in one go, in its own repo (this one), then link it
to Solace (whose side is built: deep link, ticket check, transcript intake — see CLAUDE.md). Downloads of
Electron / electron-builder approved 29/10/2026.

## Architecture
- **Electron** (main + one recorder renderer + a small settings window), TypeScript, Vitest.
- `src/core/` — pure TypeScript, no Electron import, fully unit-tested:
  speech segmentation (VAD), transcription queue, Gemini client, transcript assembly and files, the Solace
  client (ticket check, transcript upload, resend without duplicates), deep-link parsing, retention,
  settings validation.
- `src/main/` — Electron main: windows, tray, global shortcuts, protocol `tacallrecorder://`, single
  instance, file writing of recording chunks, safeStorage, the queue runner, the retention sweep.
- `src/renderer/` — capture: mic (left) + system loopback (right) through one Web Audio graph (one clock,
  so silence on the loopback is real time — R3), a stereo Opus 32 kbps recorder plus a left-only and a
  right-only recorder (P5), level meters (P4), timer (P2), pause (R5), mic-processing switch (P6),
  chunked writes so a crash keeps what was recorded (R6). After Stop: decode each mono file to PCM for the
  VAD.

## Steps
| Step | What | Status |
| --- | --- | --- |
| 0 | Scaffold; recorder: start/stop/pause, timer, stereo + left + right Opus files, meters, mic-processing switch, crash-safe chunks; unsigned NSIS installer (T14) | todo |
| 1 | Runs in the background: tray, floating bar, global shortcuts start/pause/stop, one session at a time (D-39), device check and warning (R4, D-42 where Windows allows), no lost file on error (R6) | todo |
| 2 | Transcription on the laptop: VAD per channel (option B, D-15), queue on disk that resumes after restart, Gemini inline per segment with retries, transcript `.md` + `.json`, send to Solace (ticket check before recording, upload ticket, resend = same call, D-85), 3-day permanent delete + OneDrive refusal (D-140, T20), Gemini key in safeStorage (D-141) | todo |
| 5 (app part) | Opened by Solace's deep link with the ticket checked before recording (D-143, D-144, D-147); `self_dial` (D-133); recording without a session stays local and is never sent (D-82) | todo |

## Tests the owner runs by hand (they need a real call / real audio)
T1, T2, T3, T4, T5, T10, T14 (Step 0); R1–R7; T6, T7, T8, T9, T20, T22, T37 (with role-play calls and the
real Gemini key, after Legal for real candidates).
