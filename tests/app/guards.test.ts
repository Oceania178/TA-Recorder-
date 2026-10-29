import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedRendererRequest as allowed } from "../../src/main/networkGuard";

const DIR = "C:\\app\\dist\\renderer";
const isAllowedRendererRequest = (url: string) => allowed(url, DIR);
import { findDeepLinkArg, onDeepLink, setDeepLinkHandler } from "../../src/main/deepLinkHook";

describe("renderer network block (P7)", () => {
  it("allows only local app files and in-memory data", () => {
    expect(isAllowedRendererRequest("file:///C:/app/dist/renderer/recorder.html")).toBe(true);
    expect(isAllowedRendererRequest("devtools://devtools/bundled/inspector.html")).toBe(true);
    expect(isAllowedRendererRequest("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedRendererRequest("blob:file:///1234")).toBe(true);
  });

  it("blocks every network request", () => {
    for (const url of ["https://example.com/", "http://localhost:4000/api", "wss://x.y/z", "ws://127.0.0.1/", "ftp://x/y", "chrome-extension://abc/x.js", "not a url"]) {
      expect(isAllowedRendererRequest(url), url).toBe(false);
    }
  });
});

describe("deep link hook", () => {
  afterEach(() => setDeepLinkHandler(null));

  it("finds the tacallrecorder:// argument in a command line", () => {
    const url = "tacallrecorder://start?session_id=s1&ticket=t1&dial_mode=3cx";
    expect(findDeepLinkArg(["C:\\app.exe", "--flag", url])).toBe(url);
    expect(findDeepLinkArg(["C:\\app.exe", "TACallRecorder://start"])).toBe("TACallRecorder://start");
    expect(findDeepLinkArg(["C:\\app.exe", "--smoke"])).toBeNull();
    expect(findDeepLinkArg(["--x=tacallrecorder://start"])).toBeNull();
  });

  it("hands the URL to the hook as it is, and never writes it to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const seen: string[] = [];
    setDeepLinkHandler((u) => seen.push(u));
    onDeepLink("tacallrecorder://start?ticket=SECRET");
    expect(seen).toEqual(["tacallrecorder://start?ticket=SECRET"]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });

  it("keeps a link that arrives before the hook is wired, and delivers it once", () => {
    onDeepLink("tacallrecorder://start?ticket=EARLY");
    const seen: string[] = [];
    setDeepLinkHandler((u) => seen.push(u));
    setDeepLinkHandler((u) => seen.push(u));
    expect(seen).toEqual(["tacallrecorder://start?ticket=EARLY"]);
  });
});
