import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// README.md: the shared protocol layer only depends on ChatBackend and must not
// know provider names. Keep this mechanical so the dependency direction cannot
// silently invert.
const root = import.meta.dir;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const importsProviders = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*providers\//;

test("protocols layer must not import providers", () => {
  const files = tsFiles(root);
  expect(files.length).toBeGreaterThan(0);

  const offenders = files
    .filter((file) => importsProviders.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(root.length + 1));

  expect(offenders).toEqual([]);
});