// 文档链接检查：仓库内 markdown 的本地链接必须存在。
// exec-plan 在 active/ 与 completed/ 之间移动、文档改路径时最容易留下死链；
// 外部 URL 不检查（离线、易抖动），只查相对路径与仓库内绝对路径。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface BrokenLink { file: string; line: number; target: string }

const SKIP_DIRS = new Set(["node_modules", ".git", "logs", "reports"]);
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, tel: …

function markdownFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      markdownFiles(root, join(dir, entry.name), out);
    } else if (entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

export function findBrokenLinks(root: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of markdownFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inFence = false;
    lines.forEach((text, i) => {
      if (/^\s*```/.test(text)) { inFence = !inFence; return; }
      if (inFence) return;
      for (const match of text.matchAll(LINK)) {
        const raw = match[1];
        if (EXTERNAL.test(raw)) continue;
        const target = raw.replace(/[#?].*$/, "");
        if (!target) continue; // 纯锚点
        if (!existsSync(resolve(dirname(file), target)))
          broken.push({ file: relative(root, file), line: i + 1, target: raw });
      }
    });
  }
  return broken;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const broken = findBrokenLinks(root);
  if (broken.length === 0) {
    console.log("[docs-links] 全部本地链接有效");
  } else {
    for (const b of broken) console.error(`[docs-links] ${b.file}:${b.line} → ${b.target}`);
    console.error(`[docs-links] ${broken.length} 条死链`);
    process.exit(1);
  }
}