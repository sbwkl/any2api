// codebuddy ID 体系 — 32 位小写 hex（uuid v4 去连字符）
import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID().replace(/-/g, "");
}

function lastUserKey(messages: Array<Record<string, any>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }
  }
  return "";
}

interface TurnState {
  requestId: string;
  lastUserKey: string;
}

// 会话注册表：conversationId 会话内复用；requestId 每个用户回合新生成；
// messageId 每次上游调用新生成（调用方直接 newId()）。
export class SessionRegistry {
  private conversations = new Map<string, string>();
  private turns = new Map<string, TurnState>();

  conversationFor(sessionKey: string): string {
    let id = this.conversations.get(sessionKey);
    if (!id) {
      id = newId();
      this.conversations.set(sessionKey, id);
    }
    return id;
  }

  requestIdFor(conversationId: string, messages: Array<Record<string, any>>): { requestId: string; newTurn: boolean } {
    const key = lastUserKey(messages);
    const prev = this.turns.get(conversationId);
    if (!prev || prev.lastUserKey !== key) {
      const requestId = newId();
      this.turns.set(conversationId, { requestId, lastUserKey: key });
      return { requestId, newTurn: true };
    }
    return { requestId: prev.requestId, newTurn: false };
  }

  forget(sessionKey: string): void {
    const id = this.conversations.get(sessionKey);
    this.conversations.delete(sessionKey);
    if (id) this.turns.delete(id);
  }
}