#!/usr/bin/env python3
"""Verify local Markdown links and the project docs structure."""
from pathlib import Path
import re
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_DOCS = {
    "design-docs",
    "exec-plans",
    "generated",
    "product-specs",
    "references",
}
LINK_RE = re.compile(
    r"!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\s*\)"
)
issues = []

actual_docs = {
    p.name for p in (ROOT / "docs").iterdir() if p.is_dir()
}
if actual_docs != ALLOWED_DOCS:
    issues.append(
        f"docs/ top-level mismatch: expected {sorted(ALLOWED_DOCS)}, "
        f"got {sorted(actual_docs)}"
    )

for md in sorted(ROOT.rglob("*.md")):
    rel = md.relative_to(ROOT)
    if any(part.startswith(".") or part == "node_modules" for part in rel.parts):
        continue
    text = re.sub(r"```.*?```", "", md.read_text(errors="ignore"), flags=re.S)
    for match in LINK_RE.finditer(text):
        raw = match.group(1).strip()
        if raw.startswith("<") and raw.endswith(">"):
            raw = raw[1:-1].strip()
        if (
            not raw
            or raw.startswith("#")
            or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", raw)
            or raw.startswith("//")
        ):
            continue
        raw = raw.split("#", 1)[0].split("?", 1)[0].strip()
        if not raw:
            continue
        raw = urllib.parse.unquote(raw)
        target = (md.parent / raw).resolve()
        if not target.exists():
            line = text[: match.start()].count("\n") + 1
            issues.append(f"missing local link: {rel}:{line} -> {raw}")

if issues:
    print("RESULT: FAIL")
    for issue in issues:
        print(issue)
    sys.exit(1)
print("RESULT: PASS")
print("docs structure: 0 issue(s)")
print("local Markdown links: 0 missing")
