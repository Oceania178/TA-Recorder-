// core/secret.ts — a box for a ticket or key that hides its value from every string a caller might log
// (String(), template literals, JSON.stringify, console.log / util.inspect). Read it with reveal(), only
// where it goes into a header (D-141, D-147).

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const HIDDEN = "[hidden]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [INSPECT](): string {
    return HIDDEN;
  }
}

/** The raw value of a string or a Secret. */
export const revealSecret = (s: string | Secret): string => (typeof s === "string" ? s : s.reveal());
