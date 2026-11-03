# End-to-end run: Solace + the desktop app, with mock data only

One command proves the whole TA Call Recorder flow on this laptop: the real Solace backend (branch
`feat/call-recorder-phase-0-1`) and the real desktop app (this repo, development build) together. It uses a
throwaway database, invented names and sentences, and fake servers on `127.0.0.1`. **Nothing leaves the laptop**:
no real Gemini, no real LLM, no real network.

## How Triet reruns it

```powershell
cd C:\Users\LAP15911\solace-worktrees\ta-call-recorder-app
node scripts/e2e/run.mjs
```

- Takes about 5 minutes. Three ~20-second "calls" are recorded in real time, and one upload waits for the
  app's own 30–60 s retry.
- A *TA Call Recorder* window and the small recording bar appear while it runs. Leave them alone; the script
  closes them.
- The last lines print the 12 steps, each `PASS` or `FAIL`. The exit code is 0 only when all of them pass.
- `--keep-work` keeps the throwaway folder (database, app settings, queue) for a look afterwards. Without it,
  the folder is deleted.

**Before you start:**
- Ports 4100, 4101, 4190, 4191 and 9339 must be free. Stop a Solace dev server on 4100 first. The script refuses
  to start otherwise.
- The Solace worktree `C:\Users\LAP15911\solace-worktrees\call-recorder` must have its `node_modules`
  installed. To use another checkout, set `E2E_SOLACE_DIR`.
- That worktree must **not** contain a `backend\.env` file. The script refuses if it does, because Solace would
  load real keys from it.

## What it starts, and what it never touches

| Piece | Where | Notes |
| --- | --- | --- |
| Solace backend | `:4100` | `MULTIUSER=on`, stub sign-in, `OUTLOOK_PROVIDER=mock`, automation switched off. Throwaway SQLite in `%TEMP%\tacr-e2e-<time>\`, schema from `prisma db push`. `ATS_FILES_DIR` and the secret-key file are in that folder too. |
| Logging proxy | `:4101` → `:4100` | This is the app's Solace address. It logs every request the app makes (path, type, size, a short hash), but never a ticket or any text. It loses the answer to the first upload once, to prove that a resend is the same call (D-85). |
| Fake Gemini | `:4190` | Scripted Vietnamese text per segment. It tells segments apart by pitch. One segment always answers 400; another answers 429 once, then 200. |
| Fake LLM | `:4191` | OpenAI-style `/chat/completions` for Auto-fill and Ask Sol (`LLM_API_KEY=fake`). |
| Desktop app | dev build, `--user-data-dir=<work>\app-userdata` | Debugging port 9339 (127.0.0.1) lets the script press Start / Stop through the page's own functions. |

**Test hooks.** The app uses four development-only hooks (`src/main/e2eHooks.ts`):
- `--e2e-audio`: scripted speech-like bursts instead of the mic and the system loopback;
- `--e2e-gemini-endpoint`: points the app at the fake Gemini;
- `--e2e-clock-offset-ms`: pushes the clock forward for the 3-day sweep only. Windows time is never changed.
- `--e2e-import-file`: "Import a recording" (D-171) takes this file instead of opening the Windows file picker.

They work only in a development build started with both `--dev` and `--e2e`. The installed app ignores them,
and `tests/app/e2eHooks.test.ts` proves it.

**Never touched:**
- Solace's `dev.db`, `uploads/`, `realData.json`, `backups/` and any `.env`;
- the real app profile (`%APPDATA%\ta-call-recorder`);
- `Documents\Sound Recordings`;
- the `tacallrecorder://` protocol registration, Task Scheduler (no `schtasks`) and Windows settings.

Links reach the app the way Windows would deliver them: as a command-line argument on the first start, or
through a second process for a running app.

## The 12 steps it asserts

1. **Seed:** a TA and an admin sign in. Then a job, a candidate and an application at Phone Screen, all owned by the TA.
2. **Sessions:** `POST /api/call-recorder/sessions` as the TA, for `3cx` and for `self_dial`. Each returns a deep link.
3. **Ticket check:** the app starts with the link and checks the ticket through the proxy. Solace sets `checked_at`, and the app holds the upload ticket.
4. **Record:** about 20 s of scripted audio, then Stop. The call folder has the 3 `.webm` files, `<id>.call.json` and the retention marker. Only small JSON ever reached Solace.
5. **Transcribe:** 6 turns, `ta` / `candidate` in time order. The 400 segment becomes `[không nghe rõ]`; the 429 segment is retried.
6. **Send:**
   - a `CallRecord` exists with `has_content` true;
   - a lost answer is resent, and the second attempt is a duplicate with the same `call_id`;
   - a different payload gets 409;
   - a reused link and an expired link are both refused, and nothing is recorded.
7. **Solace shows it:**
   - the calls list includes the calls;
   - the "Paste your notes" prefill holds the transcript;
   - Auto-fill keeps the salary out of the HM boxes.
8. **Search and Sol:**
   - plain search and exact search both find the call;
   - Ask Sol cites the call;
   - `ai_ready` is false with no LLM key.
9. **Local only:** a start without a link is transcribed, never sent, and the proxy sees nothing.
10. **Retention:** the app restarts with its clock 73 h ahead. The sweep deletes every call folder (the two imports too), and Solace keeps the transcript.
11. **Time tracker:** after the Confirm (move out of Phone Screen with the note and the snapshot), the call counts in the TA's time-tracker data.
12. **Import recording (D-171):** a second candidate at Phone Screen, two Solace calls, each replaced by an imported
    WAV (invented tones, written by the script):
   - stereo, its modified time 2 h ago: the window offers "Import a recording instead…", the live recording is
     deleted, the copy and the marker (3 days from the import) are in the call folder; it is sent with left = TA,
     right = candidate; Solace stores the file's own times and flags `clock_suspect`;
   - mono: the fake Gemini answers the labelled prompt; the call waits for "Which voice is yours?"; after "My voice
     is A" it is sent as ta / candidate / ta.

## Logs

Logs go to `C:\Users\LAP15911\solace-worktrees\logs\e2e-<time>\`. To use another folder, set `E2E_LOGS`.

| File | What it holds |
| --- | --- |
| `run.log` | Every check with its evidence, then the summary |
| `results.json` | The same results, as data |
| `proxy-to-solace.json` | Everything the app sent to Solace |
| `fake-gemini.json` | Every Gemini request: pitch, length, answer |
| `fake-llm.json` | Every LLM request |
| `solace.log`, `solace-no-llm.log` | The backend's output |
| `app-run*.log` | Electron's output |
| `app.log` | The app's own counts-only log |

Test values (fake keys, stub sign-in emails) are written to `notes.txt` in the work folder.
