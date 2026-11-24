import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDumpRecordsSince } from "./dump";

describe("readDumpRecordsSince", () => {
  test("parses JSONL records from a byte offset and skips invalid lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-dump-"));
    try {
      const first = JSON.stringify({ provider: "codearts", url: "u1", body: { a: 1 } }) + "\n";
      writeFileSync(join(dir, "upstream.jsonl"), first + "not-json\n" + JSON.stringify({ provider: "codebuddy", url: "u2", body: { b: 2 } }) + "\n");
      const all = await readDumpRecordsSince(dir, 0);
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual({ provider: "codearts", url: "u1", body: { a: 1 } });
      expect(all[1]).toEqual({ provider: "codebuddy", url: "u2", body: { b: 2 } });

      const tail = await readDumpRecordsSince(dir, Buffer.byteLength(first + "not-json\n"));
      expect(tail).toHaveLength(1);
      expect(tail[0].url).toBe("u2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns an empty array when the dump is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-dump-"));
    try {
      expect(await readDumpRecordsSince(dir, 0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
