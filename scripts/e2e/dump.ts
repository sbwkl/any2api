import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { capJsonBody } from "./evidence";
import type { UpstreamRequestEvidence } from "./report";

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

export async function readDumpRecordsSince(dir: string, offset: number): Promise<UpstreamRequestEvidence[]> {
  const text = await readDumpSince(dir, offset);
  const records: UpstreamRequestEvidence[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && typeof record.url === "string") {
        records.push({ ...record, body: capJsonBody(record.body) });
      }
    } catch {
      // 采集文件可能含半行或历史坏行；跳过，不影响报告
    }
  }
  return records;
}
