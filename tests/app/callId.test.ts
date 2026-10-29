import { describe, expect, it } from "vitest";
import { isValidCallId, makeCallId } from "../../src/main/callId";
import { callFileNames, IN_PROGRESS_DIR, partFileName } from "../../src/main/callFiles";

describe("makeCallId", () => {
  it("is local date-time plus a random part, so files sort by time and carry no name", () => {
    const id = makeCallId(new Date(2026, 9, 29, 14, 3, 5), () => "a1b2c3");
    expect(id).toBe("20261029-140305-a1b2c3");
  });

  it("uses real randomness by default", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const a = makeCallId(now);
    const b = makeCallId(now);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^20260102-030405-[0-9a-f]{6}$/);
  });
});

describe("isValidCallId", () => {
  it("accepts our ids and session-style ids", () => {
    expect(isValidCallId("20261029-140305-a1b2c3")).toBe(true);
    expect(isValidCallId("sess_AbC123-xyz")).toBe(true);
  });

  it("refuses anything that could escape the folder or is not an id", () => {
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "x y", "Nguyễn", "abc", "a".repeat(65), ".in-progress"]) {
      expect(isValidCallId(bad), bad).toBe(false);
    }
  });
});

describe("call file names", () => {
  it("names the three audio files and the metadata after the call id only", () => {
    expect(callFileNames("ID1234")).toEqual({
      stereo: "ID1234.webm",
      left: "ID1234.left.webm",
      right: "ID1234.right.webm",
      meta: "ID1234.call.json",
    });
  });

  it("names temp files with a .part suffix", () => {
    expect(partFileName("ID1234", "stereo")).toBe("ID1234.webm.part");
    expect(partFileName("ID1234", "left")).toBe("ID1234.left.webm.part");
    expect(partFileName("ID1234", "right")).toBe("ID1234.right.webm.part");
  });

  it("keeps calls in progress in one hidden-style folder", () => {
    expect(IN_PROGRESS_DIR).toBe(".in-progress");
  });
});
