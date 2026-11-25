import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrokenLinks } from "./check-docs-links";

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function fixture(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), "any2api-docs-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("reports relative links to missing files with line numbers", () => {
  const root = fixture({
    "a.md": "ok [b](b.md)\n\nbad [c](docs/c.md)\n",
    "b.md": "# b\n",
  });
  expect(findBrokenLinks(root)).toEqual([{ file: "a.md", line: 3, target: "docs/c.md" }]);
});

test("ignores external URLs, bare anchors and fenced code blocks", () => {
  const root = fixture({
    "a.md": [
      "[web](https://example.com/x)",
      "[anchor](#usage)",
      "```",
      "[broken-in-code](missing.md)",
      "```",
    ].join("\n"),
  });
  expect(findBrokenLinks(root)).toEqual([]);
});

test("resolves links relative to the containing file", () => {
  const root = fixture({
    "docs/a.md": "[spec](../docs/b.md) [gone](../c.md)",
    "docs/b.md": "# b\n",
  });
  expect(findBrokenLinks(root)).toEqual([{ file: "docs/a.md", line: 1, target: "../c.md" }]);
});