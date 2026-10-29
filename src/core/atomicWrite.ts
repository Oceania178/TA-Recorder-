// core/atomicWrite.ts — write a file so a crash or power cut leaves either the old or the new content,
// never half a file: write a temp file beside it, then rename over the target. On Windows an antivirus or
// indexer can hold the target for a moment (EPERM / EBUSY / EACCES), so the rename is retried briefly.
import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { flush: true });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!RETRY_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 20 * attempt));
      }
    }
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
