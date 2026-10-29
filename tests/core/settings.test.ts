import { describe, it, expect } from "vitest";
import {
  validateSolaceBaseUrl, isUnderOneDrive, validateRecordingsFolder, defaultRecordingsFolder,
  validateGeminiModel, DEFAULT_GEMINI_MODEL, normaliseSettings,
} from "../../src/core/settings";

describe("validateSolaceBaseUrl (D-143)", () => {
  it("accepts an https origin and returns it without a trailing slash", () => {
    expect(validateSolaceBaseUrl("https://solace.vnggames.com")).toEqual({ ok: true, url: "https://solace.vnggames.com" });
    expect(validateSolaceBaseUrl("  https://Solace.VNGGames.com/  ")).toEqual({ ok: true, url: "https://solace.vnggames.com" });
    expect(validateSolaceBaseUrl("https://solace.test:8443")).toEqual({ ok: true, url: "https://solace.test:8443" });
  });

  const refused: Array<[string, unknown, string]> = [
    ["empty", "  ", "empty"],
    ["not a string", undefined, "empty"],
    ["junk", "solace", "not_a_url"],
    ["http", "http://solace.vnggames.com", "not_https"],
    ["another scheme", "ftp://solace.vnggames.com", "not_https"],
    ["a path", "https://solace.vnggames.com/api", "has_path"],
    ["a query", "https://solace.vnggames.com/?x=1", "has_query"],
    ["an empty query", "https://solace.vnggames.com?", "has_query"],
    ["a fragment", "https://solace.vnggames.com/#a", "has_fragment"],
    ["credentials", "https://u:p@solace.vnggames.com", "has_credentials"],
    ["http localhost without the dev flag", "http://localhost:4000", "not_https"],
  ];
  for (const [name, input, reason] of refused) {
    it(`refuses ${name}`, () => expect(validateSolaceBaseUrl(input)).toEqual({ ok: false, reason }));
  }

  it("allows http://localhost only with the dev flag", () => {
    expect(validateSolaceBaseUrl("http://localhost:4000", { dev: true })).toEqual({ ok: true, url: "http://localhost:4000" });
    expect(validateSolaceBaseUrl("http://127.0.0.1:4000", { dev: true })).toEqual({ ok: true, url: "http://127.0.0.1:4000" });
    expect(validateSolaceBaseUrl("http://solace.vnggames.com", { dev: true })).toEqual({ ok: false, reason: "not_https" });
    expect(validateSolaceBaseUrl("http://localhost.evil.com", { dev: true })).toEqual({ ok: false, reason: "not_https" });
  });
});

describe("isUnderOneDrive (T20, D-140)", () => {
  const env = {
    OneDrive: "C:\\Users\\an\\OneDrive - VNG Group JSC",
    OneDriveCommercial: "C:\\Users\\an\\OneDrive - VNG Group JSC",
    OneDriveConsumer: "D:\\Personal\\OneDrive",
  };

  it("spots folders under any of the three OneDrive variables, any case, any slash", () => {
    expect(isUnderOneDrive("C:\\Users\\an\\OneDrive - VNG Group JSC\\Documents\\Rec", env)).toBe(true);
    expect(isUnderOneDrive("d:/personal/onedrive/calls", env)).toBe(true);
    expect(isUnderOneDrive("D:\\Personal\\OneDrive", env)).toBe(true);
  });

  it("spots a OneDrive folder by name even with no variable set", () => {
    expect(isUnderOneDrive("C:\\Users\\an\\OneDrive - Contoso\\Calls", {})).toBe(true);
    expect(isUnderOneDrive("C:\\Users\\an\\OneDrive\\Calls", {})).toBe(true);
  });

  it("does not flag a look-alike sibling or a normal folder", () => {
    expect(isUnderOneDrive("D:\\Personal\\OneDriveBackup\\x", { OneDriveConsumer: "D:\\Personal\\OneDrive" })).toBe(false);
    expect(isUnderOneDrive("C:\\Users\\an\\Documents\\Sound Recordings\\TA Call Recorder", env)).toBe(false);
  });

  it("ignores empty variables", () => {
    expect(isUnderOneDrive("C:\\Data", { OneDrive: "", OneDriveCommercial: "  " })).toBe(false);
  });
});

describe("recordings folder", () => {
  it("defaults to Documents\\Sound Recordings\\TA Call Recorder", () => {
    expect(defaultRecordingsFolder("C:\\Users\\an\\Documents")).toBe("C:\\Users\\an\\Documents\\Sound Recordings\\TA Call Recorder");
  });

  it("refuses OneDrive and relative paths, accepts a normal absolute folder", () => {
    expect(validateRecordingsFolder("C:\\Users\\an\\OneDrive - VNG\\Rec", {})).toEqual({ ok: false, reason: "under_onedrive" });
    expect(validateRecordingsFolder("Rec", {})).toEqual({ ok: false, reason: "not_absolute" });
    expect(validateRecordingsFolder("", {})).toEqual({ ok: false, reason: "empty" });
    expect(validateRecordingsFolder("C:/Users/an/Documents/Rec/", {})).toEqual({ ok: true, path: "C:\\Users\\an\\Documents\\Rec" });
  });
});

describe("Gemini model (D-141)", () => {
  it("defaults to gemini-3.5-transcribe", () => expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.5-transcribe"));
  it("accepts model ids and refuses anything that could change the URL", () => {
    expect(validateGeminiModel("gemini-2.5-flash")).toEqual({ ok: true, model: "gemini-2.5-flash" });
    expect(validateGeminiModel(" gemini-3.5-transcribe ")).toEqual({ ok: true, model: "gemini-3.5-transcribe" });
    for (const bad of ["", "../x", "gemini:generateContent?key=", "models/gemini", "Gemini Pro", "a".repeat(100), 3]) {
      expect(validateGeminiModel(bad)).toEqual({ ok: false, reason: "invalid_model" });
    }
  });
});

describe("normaliseSettings", () => {
  const ctx = { documentsDir: "C:\\Users\\an\\Documents", env: {} };
  it("fills defaults", () => {
    expect(normaliseSettings({}, ctx)).toEqual({
      ok: true,
      settings: { solaceBaseUrl: null, recordingsFolder: "C:\\Users\\an\\Documents\\Sound Recordings\\TA Call Recorder", geminiModel: "gemini-3.5-transcribe" },
    });
  });
  it("lists every bad field", () => {
    const r = normaliseSettings({ solaceBaseUrl: "http://x.com", recordingsFolder: "C:\\Users\\an\\OneDrive\\R", geminiModel: "../" }, ctx);
    expect(r).toEqual({ ok: false, errors: [
      { field: "solaceBaseUrl", reason: "not_https" },
      { field: "recordingsFolder", reason: "under_onedrive" },
      { field: "geminiModel", reason: "invalid_model" },
    ] });
  });
});
