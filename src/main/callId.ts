// A call id names the call's folder and files. It carries the time and a random part, never a candidate name.
import { randomBytes } from "node:crypto";

const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** e.g. 20261029-140305-a1b2c3 (local time, so files sort by when the call happened). */
export function makeCallId(now: Date, randomHex: () => string = () => randomBytes(3).toString("hex")): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomHex()}`;
}

/** Only plain letters, digits, '-' and '_' (6-64 chars), so an id can never point outside its folder. */
export function isValidCallId(id: string): boolean {
  return CALL_ID_PATTERN.test(id);
}
