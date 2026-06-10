import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SeedLedger } from "./apply.js";

export function emptyLedger(): SeedLedger {
  return { version: 1, epics: {} };
}

/** seed-ledger を読む。ファイル無し/破損/不正形式は空台帳として扱う。 */
export async function loadSeedLedger(path: string): Promise<SeedLedger> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SeedLedger>;
    if (!raw || typeof raw !== "object" || typeof raw.epics !== "object" || raw.epics === null) return emptyLedger();
    return { version: raw.version ?? 1, epics: raw.epics };
  } catch {
    return emptyLedger();
  }
}

/** 原子的書込: 一意な temp に書いて rename（state/store.ts と同手法）。 */
export async function saveSeedLedger(path: string, ledger: SeedLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
  await rename(tmp, path);
}
