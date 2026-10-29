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
| 0 | Scaffold; recorder: start/stop/pause, timer, stereo + left + right Opus files, meters, mic-processing switch, crash-safe chunks; unsigned NSIS installer (T14) | recorder built and tested (APP-A, 29/10/2026 — see "Recorder"); `npm run selftest:audio` passes on Triet's laptop (real mic + loopback, 3 files decode, silent loopback keeps time, crash keeps the call). Installer not built yet (controller, last). T1–T5, T10, T14 by hand |
| 1 | Runs in the background: tray, floating bar, global shortcuts start/pause/stop, one session at a time (D-39), device check and warning (R4, D-42 where Windows allows), no lost file on error (R6) | built (APP-A, 29/10/2026). D-42 "which app is playing" is **not possible** from Electron without native code: the app shows the recorded output device and warns on a silent channel instead. R1–R7 by hand |
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
(with the end time) — already done by the recorder (`CallWriter`, crash recovery); `JobQueue.open(<appData>\queue.json)`; a `QueueRunner` whose `transcribe` /
`send` are `transcribeJob` / `sendJob`; `drain()` after each Stop, at start-up and at `nextWakeAt()`;
`sweepRecordings` at start-up and periodically, then `queue.forget(deletedIds)`. Job times are ISO with
the zone, e.g. `formatIsoWithOffset(Date.now(), -new Date().getTimezoneOffset())`.

## Recorder (`src/main/` + `src/renderer/`, APP-A, 29/10/2026)
- **Files of one call** (named by the call id only, never a candidate name — D-84): while recording,
  `<recordings>\.in-progress\<id>\<id>.webm.part`, `.left.webm.part`, `.right.webm.part`, 1 s chunks
  appended in order. **Stop** renames them and moves the folder to `<recordings>\<id>\`:
  `<id>.webm` (stereo, left = you, right = other side), `<id>.left.webm`, `<id>.right.webm`, all Opus
  32 kbps in WebM; plus `<id>.call.json` (start / end, recorded length, pauses, mic setting, status
  `complete` or `recovered`) and core's retention marker `ta-call-recorder.call.json`, so the 3-day sweep
  finds it (D-140). Call id = local date-time + 6 random hex, e.g. `20261029-140305-a1b2c3`.
- **One clock (R2, R3):** mic and loopback go through one `AudioContext` into a `ChannelMerger`. Windows
  loopback delivers nothing while no sound plays, but the context keeps rendering on its own clock and an
  empty source gives zeros, so the right channel gets real-time silence. Checked on this laptop: with
  nothing playing, `right.webm` is exactly as long as `left.webm` (4.98 s each). T3 checks it over 60 min.
- **Pause (R5) — decision: cut + marks.** Pause stops all three recorders, so paused time is **not** in
  the audio (a 30 s pause makes the files 30 s shorter). The timer shows recorded time only. Each pause is
  written to `<id>.call.json` as `{ at_recorded_ms, paused_at, resumed_at }`, so the real clock time of any
  point can be worked out.
- **Crash (R6):** chunks reach the disk every second. If the page crashes, main keeps what arrived; if
  the whole app dies, the next start finishes the leftover into `<recordings>\<id>\` with status
  `recovered` and says so in the window. Up to the last ~1–2 s can be lost.
- **Background (Step 1):** closing the window hides it to the tray (grey idle, red recording, amber
  paused). Tray menu: Start / Pause / Stop / Open / Settings / Quit. Quit during a call stops and saves
  first. A small always-on-top bar shows the timer, two meters, Pause and Stop while recording.
  Shortcuts: **Ctrl+Alt+R** start / stop, **Ctrl+Alt+P** pause / resume (shown in the window; if another
  app owns one, the window says so). One call at a time: a second start is refused with a message (D-39).
- **Device check (R4, best effort):** the app records Windows' *default output device*. It lists output
  devices and warns when the *default communications device* (where call apps such as 3CX often play) is a
  different one. It also warns when one channel has been silent for over a minute (D-42).
- **D-42 limit:** naming *which app* is playing audio or using the mic needs Windows Core Audio session
  APIs, which Chromium/Electron do not expose. It would need a native add-on; not built, not faked.
- **Security (P7):** pages are sandboxed with a narrow preload API; every non-file request from them is
  blocked; only mic and screen/loopback capture are allowed. The deep link goes untouched to
  `onDeepLink(url)` in `src/main/deepLinkHook.ts` and is never logged (D-147); APP-C wires it to core.
  The protocol is registered by the installer and by the packaged app; in development only with
  `--register-protocol`.
- **Recordings folder:** default `Documents\Sound Recordings\TA Call Recorder\`; *Settings → Change…*
  picks another; a folder inside OneDrive is refused (T20, core's `isUnderOneDrive`).
- **Mic processing (P6):** off by default (your voice as it is); the switch turns echo cancellation, noise
  suppression and auto gain on together for the next recording.
- **Checks a developer runs:** `npm test` (unit tests, `tests/app/` + `tests/core/`), `npm run smoke`
  (window loads, exits 0), `npm run selftest:audio` (records ~5 s of the real mic + system audio with one
  pause into a temp folder, decodes the files, crashes the page mid-call, then deletes everything it
  recorded; prints only sizes, durations and loudness).

## How Triet tests Step 0 / Step 1
Use role-play calls with a colleague only (D-13). Wear the headset unless the test says not to.
Windows must let desktop apps use the mic (*Settings → Privacy → Microphone*).
1. **Quick check, no call:** `npm run selftest:audio` → the last line says `smoke-crash: ok`.
2. **Start the app:** `npm start`. Check *Settings*: the folder is outside OneDrive; *Device check* names
   your headset as the recorded device (if it warns, follow the hint).
3. **T1 (3CX app) / T2 (3CX web in Chrome) / T10 (Zalo PC):** press **Ctrl+Alt+R** before dialling, talk
   ~5 min, press **Ctrl+Alt+R** again. *Open folder* → the call's folder: play `…left.webm` (only you) and
   `…right.webm` (only the colleague) by dragging them into Edge or Chrome. Note anything that leaks.
4. **T3 (no headset, 60 min):** play a beep from another app at the start and the end, stay silent for
   60 s in the middle. Compare the beep positions in left and right at the start and the end (e.g. in
   Audacity): the gap should not grow.
5. **T4:** the size of `<id>.webm` for 60 min (expected ≈ 14.4 MB). The left and right files are 32 kbps
   each too, so a 60-min call takes up to ≈ 43 MB on disk in all (deleted after 3 days).
6. **T5 / R5:** mute in 3CX and talk → your voice is still in the left file (the app opens the mic
   itself). Then **Ctrl+Alt+P**, talk for 30 s, **Ctrl+Alt+P**: those 30 s are not in the files, and
   `<id>.call.json` lists the pause.
7. **Background:** close the window → the app stays in the tray. Start with Ctrl+Alt+R → tray dot red and
   the floating bar appears; pause → amber. Try to start a second recording from the tray → refused with
   a message. Quit from the tray during a call → the call is saved.
8. **R4:** in *Windows Sound settings* make the default *communications* device different from the
   default device → *Check again* shows a warning. Set 3CX's speaker to a device the app does not record →
   after a minute of silence on the right, the window and the bar warn.
9. **R6:** during a short test call, end *TA Call Recorder* in Task Manager. Start the app again → it says
   "Recovered 1 recording(s)"; the files play; `<id>.call.json` says `recovered`.
10. **T20 (folder part):** *Settings → Change…* → pick a folder inside OneDrive → refused.
11. **P6:** record twice, Mic processing off and on; compare your voice in the left files.
12. **R7:** watch CPU and memory of *TA Call Recorder* in Task Manager during a call; note the numbers.

## Tests the owner runs by hand (they need a real call / real audio)
T1, T2, T3, T4, T5, T10, T14 (Step 0); R1–R7; T6, T7, T8, T9, T20, T22, T37 (with role-play calls and the
real Gemini key, after Legal for real candidates).
