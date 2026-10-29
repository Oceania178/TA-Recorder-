// core/index.ts — the public API of the core library (pure TypeScript, no Electron). Electron main imports
// from here; see docs/plan.md "Core modules" for how the pieces fit.
export * from "./types";
export { Secret, revealSecret } from "./secret";
export { parseDeepLink, findDeepLinkInArgv, StartLink, DEEP_LINK_SCHEME, type DeepLinkResult, type DeepLinkRefusal } from "./deepLink";
export {
  validateSolaceBaseUrl, isUnderOneDrive, defaultRecordingsFolder, validateRecordingsFolder, validateGeminiModel,
  normaliseSettings, DEFAULT_GEMINI_MODEL, type AppSettings, type SettingsError, type Env,
} from "./settings";
export {
  checkTicket, uploadTranscript, serialisePayload, TICKET_CHECK_PATH, TRANSCRIPTS_PATH, MAX_UPLOAD_BYTES,
  type SolaceDeps, type CheckResult, type UploadResult,
} from "./solaceClient";
export { detectSpeech, DEFAULT_VAD, type VadOptions } from "./vad";
export { encodeWav, resample, slicePcm, WAV_SAMPLE_RATE } from "./wav";
export { transcribeSegment, GEMINI_PROMPT, GEMINI_ENDPOINT, type GeminiDeps, type TranscribeResult, type GeminiUsage } from "./gemini";
export {
  assembleTurns, hasContent, buildTranscriptFile, toPayload, renderMarkdown, writeTranscriptFiles, readTranscriptFile,
  formatIsoWithOffset, sanitiseTurnText, transcriptPaths, HAS_CONTENT_MIN_CANDIDATE_TURNS, type TranscriptFile, type ChannelText,
} from "./transcript";
export {
  JobQueue, QueueRunner, type Job, type NewJob, type Stage, type FailureReason, type Failure, type StepOutcome,
  type SendOutcome, type RunnerDeps,
} from "./queue";
export { sweepRecordings, writeCallMarker, readCallMarker, RETENTION_MS, MARKER_FILE, type SweepReport, type CallMarker } from "./retention";
export { transcribeJob, sendJob, isoOffsetMinutes, type PipelineDeps, type SendDeps, type DecodedCall } from "./pipeline";
export { writeFileAtomic } from "./atomicWrite";
export type { FetchLike, ResponseLike, RequestInitLike } from "./http";
