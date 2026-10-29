// Secrets on this laptop: the Gemini key (D-141) and the upload tickets Solace hands out at the ticket check
// (D-147). Both are encrypted with Electron safeStorage (Windows DPAPI: only this Windows user can read them)
// into files under <userData>\secrets\. Never in settings.json, the queue file, logs or the window.
// - The key is shown back only as its last 4 characters.
// - Each upload ticket is kept per Solace session (= the call id) with its send-by time, until the call is
//   sent, refused for good, or its 72 h window has closed (D-144).
// - Without Windows encryption (rare) the key is refused, and tickets stay in memory only (lost on quit).
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDialMode, writeFileAtomic, type DialMode } from "../core";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface HeldTicket {
  /** Solace's upload_until (ISO). */
  sendBy: string;
  dialMode: DialMode;
  /** The Solace origin the ticket was checked at: the transcript goes only there (APP review M2). */
  origin: string;
  /** sha256 of the link ticket that was checked (APP review M3); the link ticket itself is never kept. */
  linkTicketHash: string;
}

export type SaveResult = { ok: true } | { ok: false; message: string };

const KEY_FILE = "gemini-key.bin";
const TICKETS_DIR = "tickets";
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Google API keys are ~39 printable characters; allow some room, never spaces. */
const KEY_SHAPE = /^[\x21-\x7e]{10,200}$/;

interface StoredTicket extends HeldTicket {
  ticket: string;
}

export class SecretStore {
  private readonly memoryTickets = new Map<string, StoredTicket>();

  constructor(private readonly o: { dir: string; crypto: SafeStorageLike }) {}

  /** True when secrets can be written to disk encrypted. */
  canPersist(): boolean {
    try {
      return this.o.crypto.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private get keyFile(): string {
    return join(this.o.dir, KEY_FILE);
  }

  private ticketFile(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new Error("Refused: unsafe session id");
    return join(this.o.dir, TICKETS_DIR, `${sessionId}.bin`);
  }

  private async readEncrypted(file: string): Promise<string | null> {
    if (!this.canPersist()) return null;
    try {
      return this.o.crypto.decryptString(await readFile(file));
    } catch {
      return null;
    }
  }

  private async writeEncrypted(file: string, plain: string): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFileAtomic(file, this.o.crypto.encryptString(plain));
  }

  // ---- Gemini key ----

  async setGeminiKey(raw: string): Promise<SaveResult> {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!KEY_SHAPE.test(key)) return { ok: false, message: "That does not look like a Gemini API key (letters and digits, no spaces)." };
    if (!this.canPersist()) {
      return { ok: false, message: "Windows secure storage is not available for this user, so the key was not saved." };
    }
    await this.writeEncrypted(this.keyFile, key);
    return { ok: true };
  }

  async getGeminiKey(): Promise<string | null> {
    const key = (await this.readEncrypted(this.keyFile))?.trim();
    return key ? key : null;
  }

  async clearGeminiKey(): Promise<void> {
    await rm(this.keyFile, { force: true });
  }

  /** "•••• wxyz" — the only way the key is ever shown back. */
  async geminiKeyHint(): Promise<string | null> {
    const key = await this.getGeminiKey();
    return key ? `•••• ${key.slice(-4)}` : null;
  }

  // ---- upload tickets (D-147) ----

  async saveTicket(sessionId: string, ticket: string, held: HeldTicket): Promise<void> {
    const file = this.ticketFile(sessionId);
    const entry: StoredTicket = { ticket, sendBy: held.sendBy, dialMode: held.dialMode, origin: held.origin, linkTicketHash: held.linkTicketHash };
    this.memoryTickets.set(sessionId, entry);
    if (this.canPersist()) await this.writeEncrypted(file, JSON.stringify(entry));
  }

  private async entry(sessionId: string): Promise<StoredTicket | null> {
    const file = this.ticketFile(sessionId);
    const inMemory = this.memoryTickets.get(sessionId);
    if (inMemory) return inMemory;
    const text = await this.readEncrypted(file);
    if (!text) return null;
    try {
      const e = JSON.parse(text) as StoredTicket;
      if (typeof e.ticket !== "string" || typeof e.sendBy !== "string" || !isDialMode(e.dialMode)) return null;
      if (typeof e.origin !== "string" || typeof e.linkTicketHash !== "string") return null;
      this.memoryTickets.set(sessionId, e);
      return e;
    } catch {
      return null;
    }
  }

  async getTicket(sessionId: string): Promise<string | null> {
    return (await this.entry(sessionId))?.ticket ?? null;
  }

  async heldTicket(sessionId: string): Promise<HeldTicket | null> {
    const e = await this.entry(sessionId);
    return e ? { sendBy: e.sendBy, dialMode: e.dialMode, origin: e.origin, linkTicketHash: e.linkTicketHash } : null;
  }

  async forgetTicket(sessionId: string): Promise<void> {
    const file = this.ticketFile(sessionId);
    this.memoryTickets.delete(sessionId);
    await rm(file, { force: true });
  }

  /** Drops tickets whose 72 h send window has closed (they can never be used). Returns how many. */
  async pruneExpired(nowMs: number): Promise<number> {
    const ids = new Set(this.memoryTickets.keys());
    try {
      for (const name of await readdir(join(this.o.dir, TICKETS_DIR))) {
        if (name.endsWith(".bin")) ids.add(name.slice(0, -4));
      }
    } catch {
      // no tickets folder yet
    }
    let removed = 0;
    for (const id of ids) {
      if (!SAFE_ID.test(id)) continue;
      const e = await this.entry(id);
      const sendBy = e ? Date.parse(e.sendBy) : NaN;
      if (!e || Number.isNaN(sendBy) || sendBy < nowMs) {
        await this.forgetTicket(id);
        removed++;
      }
    }
    return removed;
  }
}

/** Without safeStorage (the `--sweep` mode): delete one call's ticket file. Encrypted content is never read. */
export async function deleteTicketFile(secretsDir: string, sessionId: string): Promise<void> {
  if (!SAFE_ID.test(sessionId)) return;
  await rm(join(secretsDir, TICKETS_DIR, `${sessionId}.bin`), { force: true });
}
