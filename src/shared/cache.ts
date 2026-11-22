// Prompt cache control — 对齐同类 CodeBuddy 2API 项目的自动缓存策略。
// 对单段文本最长的一条 system 与最后一条 user 消息（单段 ≥1024）加 `cache_control: {type:"ephemeral"}`；
// 选取与可缓存使用同一标准（单段长度），避免「总长大但无单段达标」被选中却加不上。

const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;

function hasCacheControl(content: any): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => !!part && typeof part === "object" && "cache_control" in part)
  );
}

function contentLength(content: any): number {
  if (typeof content === "string") return content.trim().length;
  if (Array.isArray(content)) {
    let max = 0;
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        const length = part.text.trim().length;
        if (length > max) max = length;
      }
    }
    return max;
  }
  return 0;
}

function addCacheControl(message: any): any {
  if (hasCacheControl(message.content)) return message;

  if (typeof message.content === "string" && message.content.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH) {
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
    };
  }

  if (Array.isArray(message.content)) {
    const index = message.content.findIndex(
      (part: any) =>
        !!part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH,
    );
    if (index >= 0) {
      return {
        ...message,
        content: message.content.map((part: any, i: number) =>
          i === index && part && typeof part === "object"
            ? { ...part, cache_control: { type: "ephemeral" } }
            : part,
        ),
      };
    }
  }

  return message;
}

export function applyPromptCacheControl(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const indexes = new Set<number>();
  let systemIndex = -1;
  let longest = 0;
  messages.forEach((message, i) => {
    if (message?.role !== "system") return;
    const length = contentLength(message.content);
    if (length > longest) {
      longest = length;
      systemIndex = i;
    }
  });
  if (systemIndex >= 0) indexes.add(systemIndex);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      indexes.add(i);
      break;
    }
  }

  if (indexes.size === 0) return messages;
  return messages.map((message, i) => (indexes.has(i) ? addCacheControl(message) : message));
}