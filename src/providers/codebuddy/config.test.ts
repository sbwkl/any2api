import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentPrompt,
  loadCredentials,
  loadProductConfig,
  renderPrompt,
  selectPrompt,
} from "./config";
import type { ProductConfig, PromptEntry } from "./types";

const prompts: PromptEntry[] = [
  { name: "craft-agent-prompt", template: "default {{ ModelNamePrompt }}" },
  { name: "craft-agent-prompt", template: "gpt {{ ModelNamePrompt }}", tags: ["gpt-5.4"] },
  { name: "craft-agent-prompt", template: "claude", tags: ["claude-4.5"] },
  { name: "ask-agent-prompt", template: "ask" },
];

const baseConfig: ProductConfig = {
  endpoint: "https://example.test",
  productName: "CodeBuddy",
  platform: "CodeBuddyIDE",
  deploymentType: "SaaS",
  version: "3.10.0",
  models: [{ id: "hy4flash-free", name: "Hy4 flash" }],
  agents: [],
  prompts,
};

const oldEnv = { ...process.env };
afterEach(() => {
  process.env = { ...oldEnv };
});

describe("config", () => {
  test("renderPrompt strips comments and fills variables", () => {
    const out = renderPrompt("{# c #}\nHi {{ Name }}! {{ Missing }}", { Name: "X" });
    expect(out).toBe("\nHi X! ");
  });

  test("selectPrompt prefers tagged variants, then the untagged default", () => {
    expect(selectPrompt(prompts, "craft-agent-prompt", "gpt-5.4")?.template).toBe("gpt {{ ModelNamePrompt }}");
    expect(selectPrompt(prompts, "craft-agent-prompt", "hy4flash-free")?.template).toBe("default {{ ModelNamePrompt }}");
    expect(selectPrompt(prompts, "ask-agent-prompt", "hy4flash-free")?.template).toBe("ask");
    expect(selectPrompt(prompts, "missing", "hy4flash-free")).toBeUndefined();
  });

  test("buildAgentPrompt wraps craft/ask and skips chat", () => {
    const craft = buildAgentPrompt(baseConfig, "craft", { id: "hy4flash-free", name: "Hy4 flash" });
    expect(craft).toContain("<system_prompt>");
    expect(craft).toContain("powered by Hy4 flash model");
    expect(buildAgentPrompt(baseConfig, "ask", { id: "hy4flash-free", name: "Hy4 flash" })).toContain("ask");
    expect(buildAgentPrompt(baseConfig, "chat", { id: "hy4flash-free", name: "Hy4 flash" })).toBeUndefined();
  });

  test("loadProductConfig reads product.json and adds agent models", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-genie-"));
    try {
      writeFileSync(join(dir, "product.json"), JSON.stringify({
        endpoint: "https://copilot.tencent.com",
        productName: "CodeBuddy",
        platform: "CodeBuddyIDE",
        deploymentType: "SaaS",
        models: [{ id: "m1", name: "M1", maxOutputTokens: 100 }],
        agents: [{ name: "craft", models: ["m2"] }],
        prompts: [],
      }));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      process.env.CODEBUDDY_GENIE_HOME = dir;
      const cfg = loadProductConfig();
      expect(cfg.version).toBe("9.9.9");
      expect(cfg.models.map((m) => m.id)).toEqual(expect.arrayContaining(["m1", "m2", "hy4flash-free"]));
      expect(cfg.models.find((m) => m.id === "m1")?.maxOutputTokens).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadCredentials prefers explicit env", () => {
    process.env.CODEBUDDY_TOKEN = "tok";
    process.env.CODEBUDDY_UID = "u1";
    process.env.CODEBUDDY_REFRESH_TOKEN = "ref";
    const creds = loadCredentials();
    expect(creds.accessToken).toBe("tok");
    expect(creds.uid).toBe("u1");
    expect(creds.source).toBe("env");
  });
});