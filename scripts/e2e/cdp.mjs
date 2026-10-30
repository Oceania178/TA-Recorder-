// A tiny Chrome DevTools Protocol client (Node 22+ has WebSocket built in). The e2e run starts the development
// app with --remote-debugging-port on 127.0.0.1 and uses this to read the recorder page and press its buttons
// through the page's own functions — the same calls a click makes. No app code is involved.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connectPage(port, urlPart, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let target = null;
  while (!target && Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && String(t.url).includes(urlPart)) ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error(`no page with ${urlPart} on the debugging port`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", () => fail(new Error("CDP connection failed")), { once: true });
  });
  let nextId = 1;
  const waiting = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      const id = nextId++;
      waiting.set(id, done);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    /** Evaluates an expression in the page (promises awaited) and returns its JSON value. */
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.error) throw new Error(r.error.message);
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page exception");
      return r.result?.result?.value;
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}
