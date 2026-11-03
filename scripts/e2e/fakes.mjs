// The fake servers of the end-to-end run, all on 127.0.0.1 (nothing leaves this laptop):
//   - fake Gemini: answers generateContent with scripted Vietnamese text per segment, told apart by pitch;
//   - fake LLM (OpenAI-compatible /chat/completions) for Solace's Auto-fill and Ask Sol;
//   - a logging proxy in front of Solace: the app's Solace address points here, so every byte the app sends
//     to Solace is seen and logged (method, path, type, size, a hash — never a ticket or the transcript text).
// Each server keeps its own request log (an array) that run.mjs asserts on and writes to the logs folder.
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";

const readBody = (req) =>
  new Promise((done, fail) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => done(Buffer.concat(parts)));
    req.on("error", fail);
  });

const listen = (server, port) => new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(port, "127.0.0.1", () => done(server));
});

// ---------- fake Gemini ----------

/** The scripted turns (pitch → what Gemini "hears"). Same pitches as src/renderer/fakeAudio.ts. */
export const GEMINI_SCRIPT = {
  330: { text: "Chào em, anh là Minh bên tuyển dụng, em nghe rõ không?" },
  660: { text: "Dạ em chào anh, em nghe rõ ạ." },
  440: { text: "Em cho anh hỏi mức lương mong muốn của em là bao nhiêu?", first429: true },
  // Only the first call holds the salary sentence, so Solace can tie it to exactly one call (D-87).
  770: { text: "Dạ em mong khoảng 35 triệu một tháng ạ.", laterText: "Dạ vâng, em có thể bắt đầu sau một tháng ạ." },
  550: { status400: true },
  880: { text: "Em đã làm thiết kế màn chơi với Unity được ba năm ạ." },
};
const PITCHES = Object.keys(GEMINI_SCRIPT).map(Number);

/** D-171: the answer to the labelled prompt of a mono import (one chunk): A is the recruiter here. */
export const DIARIZED_ANSWER = [
  "A 00:00 | Chào em, anh gọi về vị trí Game Designer.",
  "B 00:03 | Dạ em chào anh, em mong lương khoảng 30 triệu.",
  "A 00:06 | Cảm ơn em, anh sẽ báo lại.",
].join("\n");

/** 16-bit mono WAV → its pitch, from the zero crossings of the loud part (the fake call is pure tones). */
export function wavPitch(wav) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return { hz: 0, seconds: 0 };
  let off = 12;
  let rate = 16000;
  let data = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(off + 12);
    if (id === "data") data = wav.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!data) return { hz: 0, seconds: 0 };
  const n = Math.floor(data.length / 2);
  const thr = 0.02 * 32768;
  let sign = 0;
  let flips = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const x = data.readInt16LE(i * 2);
    if (Math.abs(x) < thr) continue;
    if (first < 0) first = i;
    last = i;
    const s = x > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) flips++;
    sign = s;
  }
  const voiced = first < 0 ? 0 : (last - first) / rate;
  return { hz: voiced > 0 ? flips / 2 / voiced : 0, seconds: n / rate };
}

export function nearestPitch(hz) {
  let best = null;
  for (const p of PITCHES) if (!best || Math.abs(p - hz) < Math.abs(best - hz)) best = p;
  return best !== null && Math.abs(best - hz) < 40 ? best : null;
}

export async function startFakeGemini(port, expectedKey) {
  const log = [];
  const seen429 = new Set();
  const answered = new Map();
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { t: new Date().toISOString(), method: req.method, path: req.url, key_header_ok: req.headers["x-goog-api-key"] === expectedKey, key_in_url: /key=/i.test(req.url ?? "") };
    const reply = (status, json, headers = {}) => {
      entry.status = status;
      log.push(entry);
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    };
    if (req.method !== "POST" || !/^\/v1beta\/models\/[a-z0-9.-]+:generateContent$/.test(req.url ?? "")) return reply(404, { error: { code: 404 } });
    if (!entry.key_header_ok) return reply(403, { error: { code: 403, message: "bad key" } });
    let wav = null;
    try {
      const j = JSON.parse(body.toString("utf8"));
      const part = j.contents?.[0]?.parts?.find((p) => p.inline_data);
      entry.mime = part?.inline_data?.mime_type ?? null;
      entry.has_prompt = typeof j.contents?.[0]?.parts?.[0]?.text === "string";
      wav = part ? Buffer.from(part.inline_data.data, "base64") : null;
    } catch {
      return reply(400, { error: { code: 400, message: "not json" } });
    }
    if (!wav) return reply(400, { error: { code: 400, message: "no audio" } });
    // D-171: a mono import asks for labelled turns of a whole chunk (core/diarize.ts DIARIZE_PROMPT).
    let prompt = "";
    try { prompt = JSON.parse(body.toString("utf8")).contents?.[0]?.parts?.[0]?.text ?? ""; } catch { /* checked above */ }
    if (/^This audio is a phone call between two people/.test(prompt)) {
      entry.kind = "diarize";
      return reply(200, { candidates: [{ content: { role: "model", parts: [{ text: DIARIZED_ANSWER }] }, finishReason: "STOP" }] });
    }
    const { hz, seconds } = wavPitch(wav);
    const pitch = nearestPitch(hz);
    Object.assign(entry, { wav_seconds: Math.round(seconds * 100) / 100, hz: Math.round(hz), pitch });
    const script = pitch ? GEMINI_SCRIPT[pitch] : null;
    if (!script) return reply(200, { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] });
    if (script.status400) return reply(400, { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } });
    if (script.first429 && !seen429.has(pitch)) {
      seen429.add(pitch);
      return reply(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { "Retry-After": "1" });
    }
    const n = (answered.get(pitch) ?? 0) + 1;
    answered.set(pitch, n);
    const text = n > 1 && script.laterText ? script.laterText : script.text;
    reply(200, {
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12, totalTokenCount: 62 },
    });
  });
  await listen(server, port);
  return { server, log };
}

// ---------- fake LLM (Solace's Auto-fill and Ask Sol) ----------

function completion(content) {
  return { id: "fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

export async function startFakeLlm(port, expectedKey) {
  const log = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { t: new Date().toISOString(), method: req.method, path: req.url, auth_ok: req.headers.authorization === `Bearer ${expectedKey}` };
    const reply = (status, json) => {
      entry.status = status;
      log.push(entry);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return reply(404, { error: "not found" });
    if (!entry.auth_ok) return reply(401, { error: "bad key" });
    let j;
    try {
      j = JSON.parse(body.toString("utf8"));
    } catch {
      return reply(400, { error: "not json" });
    }
    const system = String(j.messages?.find((m) => m.role === "system")?.content ?? "");
    const user = String(j.messages?.filter((m) => m.role === "user").map((m) => m.content).join("\n") ?? "");
    Object.assign(entry, { model: j.model, json_mode: j.response_format?.type === "json_object", system_head: system.slice(0, 60) });

    if (/^You turn a recruiter's raw notes/.test(system)) {
      entry.kind = "autofill";
      entry.salary_rule_in_prompt = /salary information ONLY in the "salary" object/i.test([system, user].join(" "));
      entry.transcript_in_prompt = user.includes("35 triệu") && user.includes("Unity");
      // What a well-behaved model does with these notes: no money in the HM boxes, the pay only in `salary`.
      // The candidate's own turn from the notes box ("Ứng viên [mm:ss] …"), not Solace's instructions.
      const sentence = /Ứng viên \[\d+:\d+\] ([^\n]*triệu[^\n]*)/.exec(user)?.[1]?.trim() ?? null;
      entry.salary_sentence_found = sentence !== null;
      return reply(200, completion(JSON.stringify({
        functional_experience: "Ba năm thiết kế màn chơi với Unity.",
        behaviour_skills: "Trả lời rõ ràng, lịch sự.",
        motivation: "Muốn phát triển trong mảng thiết kế game.",
        strengths: "Kinh nghiệm Unity thực tế.",
        concerns: "Chưa hỏi về kinh nghiệm làm việc nhóm.",
        fit_summary: "Phù hợp để gửi CV cho quản lý tuyển dụng.",
        suggested_recommendation: "pass",
        salary: { mentioned: true, expected: "35 triệu", current: null, source_sentence: sentence },
      })));
    }
    if (/^You are Sol/.test(system)) {
      entry.kind = "sol";
      const results = user.split("\n").filter((l) => l.startsWith("TOOL search_calls RESULT:"));
      if (!results.length) {
        entry.step = "search";
        return reply(200, completion(JSON.stringify({ action: "search_calls", args: { q: "35 triệu" } })));
      }
      const ref = /"ref":"(R\d+)"/.exec(results[results.length - 1])?.[1] ?? null;
      entry.step = "answer";
      entry.ref = ref;
      return reply(200, completion(JSON.stringify({ reply: ref ? `Ứng viên mong muốn khoảng 35 triệu một tháng [${ref}].` : "Không tìm thấy." })));
    }
    entry.kind = "other";
    reply(200, completion("{}"));
  });
  await listen(server, port);
  return { server, log };
}

// ---------- logging proxy in front of Solace ----------

/**
 * Forwards everything to Solace and logs each request: method, path, content type, size, a short hash, whether
 * the body is JSON and its top-level keys, the answer's status and top-level keys. Never a header value, a
 * ticket or any text. `dropResponseOnce(sessionId)` forwards that session's next transcript upload to Solace,
 * then cuts the connection before the app sees the answer (to prove a resend is the same call, D-85).
 * `uploadTicketFor(sessionId)` is the upload ticket the app used (kept in memory only, for the 409 check).
 */
export async function startSolaceProxy(port, target) {
  const log = [];
  const uploadTickets = new Map();
  const drop = new Set();
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = {
      t: new Date().toISOString(), method: req.method, path: req.url, content_type: req.headers["content-type"] ?? null,
      bytes: body.length, sha256: body.length ? createHash("sha256").update(body).digest("hex").slice(0, 16) : null,
      has_auth: !!req.headers.authorization,
    };
    let json = null;
    if (body.length) {
      try {
        json = JSON.parse(body.toString("utf8"));
        entry.json = true;
        entry.keys = Object.keys(json);
      } catch {
        entry.json = false;
      }
    }
    const sessionId = json?.session_id ?? null;
    if (req.url === "/api/call-recorder/transcripts" && sessionId && req.headers.authorization) {
      uploadTickets.set(sessionId, req.headers.authorization.replace(/^Bearer /, ""));
      entry.session_id = sessionId;
    }
    const fwd = httpRequest({ host: target.host, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${target.host}:${target.port}` } }, (up) => {
      const parts = [];
      up.on("data", (c) => parts.push(c));
      up.on("end", () => {
        const out = Buffer.concat(parts);
        entry.status = up.statusCode;
        try {
          const r = JSON.parse(out.toString("utf8"));
          entry.answer_keys = Object.keys(r);
          if (typeof r.call_id === "string") entry.call_id = r.call_id;
          if (r.duplicate === true) entry.duplicate = true;
          if (typeof r.error === "string") entry.error = r.error;
        } catch { /* not JSON */ }
        if (sessionId && drop.has(sessionId) && req.url === "/api/call-recorder/transcripts") {
          drop.delete(sessionId);
          entry.dropped_before_app_saw_it = true;
          log.push(entry);
          req.socket.destroy();
          return;
        }
        log.push(entry);
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.end(out);
      });
    });
    fwd.on("error", () => {
      entry.status = 502;
      log.push(entry);
      res.writeHead(502);
      res.end();
    });
    fwd.end(body);
  });
  await listen(server, port);
  return {
    server,
    log,
    dropResponseOnce: (id) => drop.add(id),
    uploadTicketFor: (id) => uploadTickets.get(id) ?? null,
  };
}
