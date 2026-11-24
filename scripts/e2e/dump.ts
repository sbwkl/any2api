import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const dumpFile = (dir: string) => join(dir, "upstream.jsonl");

export async function dumpSize(dir: string): Promise<number> {
  try {
    return (await stat(dumpFile(dir))).size;
  } catch {
    return 0;
  }
}

export async function readDumpSince(dir: string, offset: number): Promise<string> {
  try {
    const buf = await readFile(dumpFile(dir));
    return buf.subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}
