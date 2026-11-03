# CLAUDE.md — TA Call Recorder (desktop app)

The Windows desktop app that records a TA's phone-screen call (3CX or another dialer), transcribes it
on the laptop with Gemini, and sends **only the transcript text** to Solace (the VNGGames ATS). Owner:
Triet (TA). Explain decisions in plain language; the owner is not a developer.

## Source of truth
- **Spec:** `docs/ta-call-recorder-spec-v1.30.md` (a copy of the Solace repo's spec — the master lives in
  Solace and on OneDrive; if they differ, the newer version wins; never edit the copy here by hand).
  - The app side is §1–§5, §8.1 (Step 0: P1–P7, T1–T14), §8.3, §8.9, §8.22 (Steps 0–2, 5), §8.23 (D-132
    wizard), §8.24 (the data contract), and decisions D-12 to D-46, D-82, D-84, D-85, D-125, D-126,
    D-132, D-133, D-135, D-139 to D-147.
- **Solace's side of the contract** (what the app calls): the Solace repo's `docs/specs/call-recorder.md`
  (worktree `C:\Users\LAP15911\solace-worktrees\call-recorder`, read only from here):
  - deep link `tacallrecorder://start?session_id=…&ticket=…&dial_mode=3cx|self_dial`;
  - ticket check `POST /api/call-recorder/tickets/check` (step ①b) → upload ticket;
  - transcript `POST /api/call-recorder/transcripts` with `Authorization: Bearer <upload ticket>` (step ②).
- **Plan and status:** `docs/plan.md`. Keep it updated in the same session as the change.

## Hard rules
- **The audio never leaves the laptop** (D-139): no route, no upload, no attachment of any audio file, ever.
  Only the transcript JSON goes to Solace, only to the pinned Solace address (D-143, https only).
- **Keys:** the Gemini key is entered by the user and stored with Electron `safeStorage` (Windows DPAPI);
  never in code, files in the repo, logs, or the transcript. Upload tickets live in memory / safeStorage only,
  never logged (D-147).
- **Logs** never contain transcript text, audio paths with names, tickets, keys, or candidate data.
- **Recordings** live under the recordings folder (default `Documents\Sound Recordings\TA Call Recorder\`),
  are deleted permanently (not to the Recycle Bin) 3 days after the call (D-140), and the folder may not be
  inside OneDrive (T20).
- **Real candidates:** Gemini may be used with real candidates only after Legal approves (D-126). Until then
  the app shows a one-time notice; tests and demos use role-play recordings only.
- **Tests:** no real network, no real Gemini, no real Solace in tests — stub `fetch`. Write tests first and
  show them red on an assertion.
- **Git:** local commits only, by path; never push. Small commits with clear messages ending with the
  co-author line the controller gives.
- Windows 11 is the target (P1). Code in TypeScript; keep files small and focused.
