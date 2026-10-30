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
| 2 | Transcription on the laptop: VAD per channel (option B, D-15), queue on disk that resumes after restart, Gemini inline per segment with retries, transcript `.md` + `.json`, send to Solace (ticket check before recording, upload ticket, resend = same call, D-85), 3-day permanent delete + OneDrive refusal (D-140, T20), Gemini key in safeStorage (D-141) | built (core APP-B, wiring APP-C, 29/10/2026 — see "Core modules" and "Integration"): queue after every Stop, chunked 16 kHz decode in a hidden page, Gemini key in safeStorage, timers, 3-day sweep hourly + a per-user logon/daily Task Scheduler task + `--sweep` mode, Recent calls. T6–T9, T20, T22, T37 by hand |
| 5 (app part) | Opened by Solace's deep link with the ticket checked before recording (D-143, D-144, D-147); `self_dial` (D-133); the app records **only** when opened from Solace's button; recording without a session (shortcut, tray, window Start) only with **Test mode** on in Settings, as a "Local only" call that is never sent (D-82, D-165) | built (APP-C, 29/10/2026 — see "Integration"); settings + first-run set-up check (D-132); Test mode (D-165) built 30/10/2026. End-to-end with Solace's "Call & record" by hand (below) |

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

Wiring (planned by APP-B, built by APP-C — see "Integration"): call folder = `<recordings>\<call id>\` with `writeCallMarker` at Start and again at Stop
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
Since D-165 the shortcut, tray and Start button record only with **Settings → Test mode** on: switch it on for
these tests (the window, tray tooltip and floating bar show "TEST MODE"), and off again afterwards.
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

## Integration (`src/main/` + `src/renderer/`, APP-C, 29/10/2026)
| Piece | What it does |
| --- | --- |
| `appSettings.ts` | `settings.json` in the app data folder: recordings folder, mic processing, **pinned Solace address**, Gemini model (empty = default), when the notice was accepted / the wizard finished, which program the cleanup task was made for. Only these fields are ever written, so a key or ticket can never land there. Default folder: `Documents\Sound Recordings\TA Call Recorder`, or `%LOCALAPPDATA%\TA Call Recorder\Recordings` when Documents is inside OneDrive. |
| `secretStore.ts` | Gemini key and upload tickets, encrypted with Electron `safeStorage` (Windows DPAPI, this Windows user only) under `<app data>\secrets\`. The key is shown back only as `•••• last4`. One ticket per Solace session, with its send-by time; forgotten once sent, refused for good, or expired. Without Windows encryption: the key is refused, tickets stay in memory. |
| `settingsActions.ts` | Solace address: https origin only (`http://localhost` only in a development build started with `--dev`); model id check; key save / remove (calls waiting for a key start at once). |
| `deepLinkFlow.ts` | `tacallrecorder://start…` → strict parse (a bad link: "This link can't start a recording", never logged) → refuse while recording (D-39) or with no Solace address (points to Settings) → **reuse the upload ticket already held for that session** (the browser opened the link twice) or check the ticket at the pinned address (step ①b) → only an "ok" records; every other answer is explained and nothing is recorded. |
| `controller.ts` | A checked session is "armed"; the next Start records it under the **session id** (D-84) with the session in `<id>.call.json` (no ticket). Start from the button, tray or shortcut records a **local-only** call (D-82): transcribed, written to `.md` / `.json`, never sent; the window says "Local only — not linked to Solace". Every saved or crash-recovered call goes to the queue. |
| `callJobs.ts` | `JobQueue` (`<app data>\queue.json`) + `QueueRunner` with core's `transcribeJob` / `sendJob`. Drains after each Stop (without delaying Stop), at start-up and at `nextWakeAt()` (a timer). **No Gemini key:** the call waits in "Recorded" with "Add a Gemini key in Settings to transcribe" and starts as soon as a key is saved. Sweep (D-140) at start-up and hourly, then forgets those jobs and tickets; jobs whose folder disappeared (the logon task) are dropped at start-up. |
| `webm.ts`, `decoderClient.ts`, `decoderWindow.ts`, `renderer/decoder.ts`, `renderer/downsample.ts`, `pcmFiles.ts` | Decoding for transcription (controller decision): main reads the Opus packets out of `<id>.left.webm` / `.right.webm`; a hidden sandboxed page decodes them **10 s at a time** with WebCodecs and brings them to **16 kHz mono**; main appends them to `<id>.left.s16` / `.right.s16` (raw 16-bit since fix round 3 — float32 `.pcm` before; written as `.part` then renamed) in the call folder, which core reads through `openPcm` as readers (fix round 1); the temp files are deleted once the transcript is written. A whole call is never held at 48 kHz. Checked on this laptop by `npm run selftest:audio` (4.98 s → 79,680 samples, same loudness as the file). Since fix round 1 no channel is ever read whole (see Fix round 1, I3). |
| `sweepMode.ts`, `cleanupTask.ts`, `build/installer.nsh` | `TA Call Recorder.exe --sweep`: deletes expired calls headless and exits (reads the queue read-only; if the app is open, the open app sweeps instead). The installed app creates the Task Scheduler task **"TA Call Recorder cleanup"** for the current user on first run (and after an update): at this user's logon and daily, lowest rights, no admin. It is made from an XML definition because a plain `schtasks /SC ONLOGON` task triggers for any user and needs admin. The uninstaller deletes it (`customUnInstall`). Development builds create it only with `--register-cleanup-task`. Tests never run `schtasks`. |
| `appLog.ts` | `<app data>\app.log` (256 KB, one old file kept): events with counts, stages, reason codes and call ids only. Tickets, keys, links, paths and any text become `[redacted]`. |
| `callsView.ts`, `renderer/recentCalls.ts` | **Recent calls**: date and time, length, linked or local only, stage (Recorded / Transcribing / Transcribed / Sending / Sent / Failed + the reason in plain words), Retry on failed calls, Open folder, Open transcript (the `.md`). No candidate names. |
| `wizardChecks.ts`, `renderer/wizard.ts`, `renderer/soundCheck.ts`, `renderer/settingsPanel.ts` | Settings panel and the **set-up check** (D-132), shown at the first start until finished, again from the tray ("Set-up check…") or Settings: 1 notice + "Use with role-play calls only until Legal approves real candidates." → "I understand"; 2 mic (opens `ms-settings:privacy-microphone` when blocked); 3 both meters move (a beep plays on the default output so the right meter moves); 4 Solace address, tested with Solace's public, content-free `GET /api/health` (no ticket is ever sent; "Call & record" is the real test); 5 3CX test dial to a number the TA types (skippable). Each step shows "Pass" / "Not yet" with the fix. |

Checks a developer runs: `npm test`; `npm run smoke` (also asks the page for settings, Recent calls and the
wizard); `npm run selftest:audio` (also decodes the left file the way transcription does).

### Fix round 1 (independent APP review, 29/10/2026)
- **Notice first (I1, D-126):** nothing records — button, tray, shortcut or Solace link — until "I understand" is
  pressed in the set-up check. A refused start says "Open Set-up check and accept the notice first." and opens
  it; a Solace link is refused before any ticket check. Closing the set-up check does not accept.
- **3 days everywhere (I2, D-140):** every recordings folder ever used is remembered (`knownRecordingsDirs` in
  `settings.json`) and swept at start-up, hourly and by `--sweep`; crash leftovers stuck in `.in-progress` are
  deleted 3 days after their newest file (never the call being recorded). `--sweep` holds the single-instance
  lock, so a stale "transcribing" stage cannot block it. A **real uninstall** (not an update) runs
  `--uninstall-purge` first: every call folder with the app's marker, in every known folder, whatever its age,
  plus the upload tickets — and, since fix round 2, the app's data in `userData` (settings, queue, log, the
  secret store with the Gemini key); electron-builder then removes the app-data folder
  (`nsis.deleteAppDataOnUninstall`), also only on a real uninstall. The notice says "Uninstalling deletes your
  recordings and the app's settings, including your Gemini key."
- **Long calls (I3):** the VAD reads each channel's temp PCM file 10 s at a time and each segment reads only its
  own samples (`openPcm`, `detectSpeechStream`), so memory stays small for any length (tested with a synthetic
  4-hour call: no read over ~31 s of audio). Recordings stop and are saved at **4 h**, with a warning at 3 h 50.
- **Minors:** Retry after "transcript missing" transcribes again (M1); the transcript goes to the Solace origin
  the ticket was checked at, kept with the ticket (M2); a held ticket is reused only for the same link ticket
  (sha256, M3); an armed Solace session only attaches to the start its link pressed (`startLinked`, M4);
  Solace's caps (5,000 turns, 300,000 characters) are checked before sending — `transcript_over_limits` (M5);
  a Gemini 400 on one segment writes "[không nghe rõ]" there and goes on, the call fails only when most
  segments fail (M6); UNC paths, mapped network drives and (fix round 2) drive letters that are not connected are refused as
  recordings folder — "Pick a folder on this laptop." (M7); the cleanup
  task is re-created at start-up when missing (`schtasks /Query`) and kept during an update (M8); an unplugged
  recordings folder keeps its jobs and tickets (M9); pages load only the app's own files (M10); the mic
  permission never includes a camera — getDisplayMedia arrives as "media" with no types (checked on this
  laptop) — the floating bar has its own two-function preload, and an `afterPack` hook
  (`build/fuses.cjs`) sets Electron's fuses: RunAsNode, NODE_OPTIONS and inspect off, cookie encryption and
  only-load-from-asar on (ASAR integrity left off: electron-builder 25 does not embed the Windows integrity
  resource, and `electronFuses` does not exist in electron-builder 25) (M11); Gemini and Solace calls use
  Chromium's network stack (`net.fetch` in its own session: Windows proxy and certificate store) (M12).
- **Clock:** when Solace's `server_time` differs from the laptop by more than 2 minutes the window warns "Your
  laptop clock is off by N min — fix Windows time, Solace may reject the call".
- **Contract lock:** a test runs an app-built payload through Solace's own `validateTranscriptUpload`
  (read-only import from the Solace worktree; skipped where that worktree is absent).

### Fix round 3 (APP review 2, 29/10/2026)
- **When the uninstall purge runs (I-R1):** no longer when the uninstaller opens. It runs inside the uninstall
  section (`customRemoveFiles`), after the TA confirmed on the uninstaller's pages and after electron-builder's
  "app is running" check, then electron-builder's own file removal runs unchanged. Cancel deletes nothing.
- **Only on a real uninstall (m-R3):** an update runs the old uninstaller with `/S /KEEP_APP_DATA` plus
  `--updated` or `--delete-app-data`; the purge and the task removal run only when neither `--updated` nor
  `/KEEP_APP_DATA` is there, so an update started with `--delete-app-data` keeps the recordings. (That flag
  still makes electron-builder delete the app-data folder on such an update — its own documented behaviour.)
  A *silent* real uninstall (`/S`, e.g. by IT) also checks for the running app (in `un.onInit`) and closes it
  before anything is deleted (APP review 3 corrected the earlier note).
- **"[không nghe rõ]" is not content (m-R1):** the placeholder turn is still sent, but never makes `has_content`
  true.
- **16-bit temp PCM (m-R4):** half the disk of float32 (about 0.46 GB per channel for a 4-hour call).
- **A start or link during `--sweep` (m-R5):** the sweeping process remembers it and, when done (seconds), starts
  the app with that request's own arguments, a Solace link included. Nothing is lost or logged.
- Upload tickets saved by builds before fix round 1 stay unusable (development builds only; controller decision).

Follow-ups: shortcuts are fixed (make them configurable later); the silence-warning thresholds are to be tuned
after real calls.

## How Triet tests Step 2 / Step 5
Role-play calls only (D-126). Start with `npm start` (or the installed app, after the controller builds it).
A development checkout needs `npm run build && npx electron . --register-protocol` once so Solace's link opens
it; add `--dev` only to test against a Solace on `http://localhost`.
1. **First start:** the set-up check opens. Step 1 → "I understand". Step 2 → Pass. Step 3 → Start, talk,
   Play beep → both bars move → Pass. Step 4 → enter Solace's address → "Solace answered" (or the
   https-only message). Step 5 → type your desk number → Test dial → 3CX opens with it → "Yes" (or skip).
   Finish.
2. **Settings:** paste the Gemini key → "Saved: •••• last4". Quit and reopen: still there, never in full.
   `%APPDATA%\ta-call-recorder\settings.json` and `app.log` must not contain the key.
3. **Test mode off (D-165):** with *Settings → Test mode* off (the default), press **Ctrl+Alt+R**, the tray's
   Start and the window's Start → each is refused with "Start the call from Solace (Call & record). To record
   without Solace, turn on Test mode in Settings." and nothing is recorded. A Solace link still records.
   **Local-only call (T6–T9 with a role-play):** switch Test mode on → "TEST MODE" shows in the window, the
   tray tooltip and the floating bar. Ctrl+Alt+R, talk ~2 min with a colleague, stop. The window
   says "Local only — not linked to Solace". Recent calls: Recorded → Transcribing → Transcribed, "Local only".
   *Open transcript* shows the turns (you = TA, colleague = candidate). Nothing reaches Solace.
4. **No key:** remove the key, record 30 s → the call stays "Recorded" with "Add a Gemini key in Settings to
   transcribe". Save the key → it is transcribed right away.
5. **Linked call (Step 5):** Solace must have `APP_BASE_URL` set to the same address as step 4. In Solace,
   press "Call & record" on a role-play candidate at phone screen → the browser asks to open TA Call
   Recorder → allow → recording starts and the window says "Linked to Solace". Talk, stop → Recent calls goes
   to **Sent**; the transcript appears in Solace's "Paste your notes". Repeat with "Record only, I'll call myself"
   (`self_dial`): the window says to dial yourself.
6. **Refusals:** open the same Solace link again after the call → "already been recorded". Open a link more
   than 30 minutes after pressing the button → "Solace did not accept this link… Nothing was recorded."
   Press "Call & record" during a recording → "Already recording a call". Clear the Solace address → a link
   says to set it in Settings.
7. **Offline (T22):** Wi-Fi off after a linked call → "Waiting to try again"; Wi-Fi on → it is sent (the timer
   retries; a resend never makes a duplicate, D-85).
8. **Fix round 1 checks:** on a fresh profile, close the set-up check without "I understand" and press
   Ctrl+Alt+R, the Start button and a Solace link → each is refused with "Open Set-up check and accept the
   notice first." and the set-up check opens. Settings → Change… to a mapped network drive (e.g. `Z:\`) →
   refused. On the company network (proxy / TLS inspection) step 4's test and a linked call must work (M12).
   Move the laptop clock 5 minutes off and start a linked call → the clock warning shows.
9. **T20 / D-140:** the network log shows only the transcript JSON going to Solace. After 3 days (or with the
   laptop clock moved forward) the call's folder is gone, not in the Recycle Bin, and the call leaves Recent
   calls. With the **installed** app: Task Scheduler shows "TA Call Recorder cleanup" under your user (at log
   on + daily) — check it was created **without** an admin prompt; quit the app, log off and on → old calls
   are deleted. Change the recordings folder once, then check calls in the **old** folder are also deleted
   after 3 days. Delete the task by hand in Task Scheduler and restart the app → it is back. **Uninstall** →
   the recordings in every folder used, the settings, the Gemini key, the task and the install folder are gone (an **update** keeps
   all of them). **Open the uninstaller and press Cancel on its first page → nothing is deleted** (recordings,
   key, settings and task all still there). Start the uninstaller while the app is recording → it asks to close
   the app before anything is deleted. Settings → Change… to a disconnected network drive letter → "Pick a folder on this laptop." A folder
   inside OneDrive is refused. Check the installed exe starts normally (the fuses are set at packaging).

### D-165 Test mode (30/10/2026)
- `settings.json` field `testMode` (off by default; not a secret). *Settings → Test mode* switches it; not during a
  recording.
- Off: every start without a Solace session — window Start, tray, Ctrl+Alt+R — is refused with "Start the call
  from Solace (Call & record). To record without Solace, turn on Test mode in Settings." (renderer, `startGate`
  and the controller all check; the controller is the last word). Solace's link records as before.
- On: the earlier local-only path, unchanged: "Local only", transcribed with Gemini if a key is set, never sent.
  "TEST MODE" shows in the window header, the tray tooltip and the floating bar.
- The notice gate (D-162) is checked first. The self-tests switch Test mode on in their throwaway profile; the
  E2E run (step 9) first checks the refusal, then switches it on with the window's Settings switch.

## Tests the owner runs by hand (they need a real call / real audio)
T1, T2, T3, T4, T5, T10, T14 (Step 0); R1–R7; T6, T7, T8, T9, T20, T22, T37 (with role-play calls and the
real Gemini key, after Legal for real candidates).

## Installer build (controller, 29/10/2026)
- `npm run dist:win` (unsigned, `CSC_IDENTITY_AUTO_DISCOVERY=false`) → `release\TA Call Recorder Setup 0.1.0.exe` (81.8 MB, NSIS, per-user, choose folder). The custom uninstall macros compiled.
- First run of electron-builder failed on Windows symlinks inside its `winCodeSign` archive ("A required privilege is not held"); fixed the same way Solace's `desktop/build-win.ps1` does: extract the archive into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` without its `darwin` folder, then build again. No admin, no Developer Mode.
- The packaged exe (fuses set, `app.asar` only) passes `--smoke`, `--smoke-capture` (real mic + loopback: three files decode at 4.98 s, silent right channel keeps time, transcription decode at 16 kHz) and `--smoke-crash` (recovered). Not installed on this laptop by the controller: installing, the uninstall Cancel test, the task, T14 and every hand test in this plan are Triet's.

## End-to-end run with Solace (E2E, 30/10/2026)
`node scripts/e2e/run.mjs` (details and how to rerun: `scripts/e2e/README.md`). It runs the real Solace backend
(`feat/call-recorder-phase-0-1`) and this app's development build together, on this laptop only, in about 5 minutes. It uses:
- a throwaway SQLite database;
- invented names and sentences;
- a fake Gemini, a fake LLM, and a logging proxy in front of Solace, all on `127.0.0.1`.

It asserts the 11 steps of the flow:
- seed;
- sessions for `3cx` and `self_dial`;
- the ticket check;
- recording and the files it leaves;
- transcription, including a 400 → "[không nghe rõ]" and a 429 → retry;
- sending, including a lost answer → a resend that becomes a duplicate with the same `call_id`, a 409 for a
  different payload, and a reused or expired link refused with nothing recorded;
- the calls list, the prefill and Auto-fill;
- search, Ask Sol and `ai_ready`;
- with Test mode off, a start without a link is refused (D-165); then Test mode is switched on in Settings and a
  local-only call is recorded, transcribed and never sent;
- the 3-day sweep with the clock moved 73 h ahead;
- the time tracker after a Confirm.

First runs on 30/10/2026: all 11 pass.

**Development-only test hooks** (`src/main/e2eHooks.ts`) used by that run:
- `--e2e-audio`: scripted speech-like bursts (`src/renderer/fakeAudio.ts`) feed the same Web Audio graph and
  recorders instead of the mic and the loopback;
- `--e2e-gemini-endpoint=http://127.0.0.1:<port>`;
- `--e2e-clock-offset-ms=<n>`: the queue and the sweep only, never Windows time.

The hooks are read only when the app is not packaged **and** was started with both `--dev` and `--e2e`.
`tests/app/e2eHooks.test.ts` proves the installed app ignores them.

Everything else the run needs comes from Electron itself:
- a temp profile (`--user-data-dir`);
- the debugging port, to press Start / Stop and save the fake Gemini key through the page's own Settings API;
- `settings.json` written before the start: notice accepted, Solace address, recordings folder.

`capture.ts` now builds the graph in `recordGraph()`, fed by either source. The real mic + loopback path is
unchanged apart from that move. **Rerun `npm run selftest:audio` once with the real devices.**

## Installer 0.1.1 (controller, 30/10/2026)
- Version 0.1.1 = everything above plus D-165 Test mode and the v1.24 spec. `release\TA Call Recorder Setup 0.1.1.exe` (81.8 MB, unsigned). Installing over 0.1.0 is an update: recordings, settings and key are kept.
- Packaged exe: `--smoke --smoke-capture --smoke-crash` pass (real mic + loopback, 3 files at 4.98 s, crash recovery). E2E script (dev build): 11/11 steps pass.
