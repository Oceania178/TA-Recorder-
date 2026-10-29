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
| 2 | Transcription on the laptop: VAD per channel (option B, D-15), queue on disk that resumes after restart, Gemini inline per segment with retries, transcript `.md` + `.json`, send to Solace (ticket check before recording, upload ticket, resend = same call, D-85), 3-day permanent delete + OneDrive refusal (D-140, T20), Gemini key in safeStorage (D-141) | core built and unit-tested (APP-B, 29/10/2026 — see "Core modules"); wiring into Electron main (decode, safeStorage, timers, Task Scheduler) is APP-C; T6–T9, T20, T22, T37 by hand |
| 5 (app part) | Opened by Solace's deep link with the ticket checked before recording (D-143, D-144, D-147); `self_dial` (D-133); recording without a session stays local and is never sent (D-82) | todo |

## Core modules (`src/core/`, APP-B, 29/10/2026)
Pure TypeScript: no Electron import; `fetch`, clock, sleep and storage are passed in, so every module is
tested without network, Gemini or Solace (164 tests in `tests/core/`). Import everything from
`src/core/index.ts`.

| Module | What it does |
| --- | --- |
| `deepLink.ts` | Parses `tacallrecorder://start?session_id&ticket&dial_mode` strictly: exactly those three parameters, `3cx` / `self_dial`, sane id and ticket characters; any extra part (a path, a port, a server address) is refused with a reason code. The result hides the link ticket from `String()`, JSON and `console.log`; `revealTicket()` only where it goes into the header. `findDeepLinkInArgv()` finds it on the command line (never log argv). |
| `settings.ts` | Pinned Solace address: https origin only, no path / query / fragment (D-143); `http://localhost` only with the `dev` flag. Recordings folder: absolute, default `Documents\Sound Recordings\TA Call Recorder`, refused inside OneDrive (`OneDrive`, `OneDriveCommercial`, `OneDriveConsumer`, or a folder named `OneDrive` / `OneDrive - …`, T20). Gemini model id, default `gemini-3.5-transcribe` (D-141). |
| `solaceClient.ts` | `checkTicket` (step ①b) → upload ticket (as a hidden `Secret`) + `sendBy`, or one of: refused, already checked, retryable, bad address. `uploadTranscript` (step ②) sends exactly the §8.24 fields — whatever else the object holds is dropped, so no file or audio can go (D-139) — and the same payload always gives the same bytes (D-85). 201 / 200 duplicate / 409 / 401 / 400 with reasons / 413 / 415 / 429 (≥ 60 s) / 5xx / network / timeout each map to one result. Redirects are refused; over 2 MB is refused before sending. |
| `vad.ts` | Speech detection per channel (option B, D-15): 20 ms frames, adaptive noise floor, 200 ms hangover, clicks under 120 ms dropped, gaps under 0.6 s merged, 150 ms padding, segments cut at their quietest moment above 30 s. Tested on synthetic tones and noise bursts. |
| `wav.ts` | A PCM slice → 16 kHz mono 16-bit WAV (resampled) for Gemini's inline upload. |
| `gemini.ts` | One segment per `generateContent` request, inline WAV, no language code (D-135), verbatim prompt that says the audio is data, not instructions; key only in the `x-goog-api-key` header, never in the URL or a result (D-141); retries 429 / 5xx / network with backoff and `Retry-After`; size guard under the ~20 MB inline limit. |
| `transcript.ts` | Turns from both channels in time order (left = `ta`, right = `candidate`); text cleaned so Solace never refuses it (one line, no box-drawing, no long base64-like runs); `has_content` = the candidate has at least `HAS_CONTENT_MIN_CANDIDATE_TURNS` (= 1) turn with words — the D-37 threshold is not set yet, change it only there; writes `<id>.transcript.json` (exactly the §8.24 payload; `session_id: null` for a local-only call) and `<id>.transcript.md`. |
| `queue.ts` | `JobQueue`: one JSON file in the app data folder, written atomically; stages `recorded → transcribing → transcribed → sending → sent`, `failed` (reason + where retry goes back to), `local_only` (no session, never sent, D-82); after a restart, work in progress steps back one stage. `QueueRunner`: one job at a time, oldest first, backoff 30 s → 30 min (at least the server's wait); no ticket, key or transcript text in the queue file — the upload ticket comes from `getUploadTicket(jobId)` (safeStorage) at send time. |
| `retention.ts` | Deletes call folders 72 h after the call ended, permanently with `fs.rm` (D-140); only folders with the app's marker file whose id matches the folder name; never follows links; counts-only report. **Decision:** deleted at 3 days whatever the job's stage (the 72 h send window has closed by then anyway), but never while the job is being transcribed or sent — the next sweep takes it. A recording with no end time (crash) is judged by its newest file. |
| `pipeline.ts` | `transcribeJob`: decoded left + right PCM → VAD → WAV → Gemini → transcript files, with a checkpoint (`<id>.progress.json` in the call folder) so a restart never pays twice for the same audio; a blocked segment becomes empty text. `sendJob`: reads the `.transcript.json`, uploads it, maps Solace's answer to a queue outcome. End-to-end test with a fake Gemini and a fake Solace. |

Wiring (APP-C): call folder = `<recordings>\<call id>\` with `writeCallMarker` at Start and again at Stop
(with the end time); `JobQueue.open(<appData>\queue.json)`; a `QueueRunner` whose `transcribe` /
`send` are `transcribeJob` / `sendJob`; `drain()` after each Stop, at start-up and at `nextWakeAt()`;
`sweepRecordings` at start-up and periodically, then `queue.forget(deletedIds)`. Job times are ISO with
the zone, e.g. `formatIsoWithOffset(Date.now(), -new Date().getTimezoneOffset())`.

## Tests the owner runs by hand (they need a real call / real audio)
T1, T2, T3, T4, T5, T10, T14 (Step 0); R1–R7; T6, T7, T8, T9, T20, T22, T37 (with role-play calls and the
real Gemini key, after Legal for real candidates).
