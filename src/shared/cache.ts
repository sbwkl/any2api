// Prompt cache control — 对齐同类 CodeBuddy 2API 项目的自动缓存策略。
// 对 system 与最后一条 user 消息（文本长度 ≥1024）加 `cache_control: {type:"ephemeral"}`；
// 如果消息里已有显式 cache_control，则保持原样，不重复添加。

const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;

function hasCacheControl(content: any): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => !!part && typeof part === "object" && "cache_control" in part)
  );
}

function addCacheControl(message: any): any {
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
  if (messages.some((message) => hasCacheControl(message?.content))) return messages;

  const indexes = new Set<number>();
  const systemIndex = messages.findIndex((message) => message?.role === "system");
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