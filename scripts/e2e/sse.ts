export interface SseFrame {
  event?: string;
  data: string;
}

export function parseSseFrames(text: string): SseFrame[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: SseFrame[] = [];
  for (const block of normalized.split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

export interface ParsedFrame {
  event?: string;
  json?: any;
  error?: string;
}

export function jsonFrames(frames: SseFrame[]): ParsedFrame[] {
  return frames.map((f) => {
    if (f.data === "[DONE]") return { event: f.event, error: "[DONE] sentinel" };
    try {
      return { event: f.event, json: JSON.parse(f.data) };
    } catch {
      return { event: f.event, error: `invalid JSON: ${f.data.slice(0, 120)}` };
    }
  });
}
