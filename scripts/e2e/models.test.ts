import { describe, expect, test } from "bun:test";
import { selectModel } from "./models";

const available = [
  "GLM-5.3-Flash",
  "glm-5.3",
  "DeepSeek-v4.1-Flash-1017",
  "Qwen-Max",
  "MiniMax-M2",
];

describe("model selection", () => {
  test("prefers the first configured model, case-insensitive", () => {
    const r = selectModel(available, ["glm-5.3-flash"]);
    expect(r).toEqual({ model: "GLM-5.3-Flash", reason: "preference" });
  });

  test("tolerates a parenthetical suffix in the preference", () => {
    const r = selectModel(available, ["DeepSeek-v4.1-Flash(1017)"]);
    expect(r).toEqual({ model: "DeepSeek-v4.1-Flash-1017", reason: "preference" });
  });

  test("falls through preferences to the env fallback", () => {
    const r = selectModel(available, ["Not-There"], "qwen-max");
    expect(r).toEqual({ model: "Qwen-Max", reason: "fallback" });
  });

  test("uses heuristics when neither preference nor fallback match", () => {
    const r = selectModel(["Big-Pro", "MiniMax-M2"], ["Not-There"], "also-gone");
    expect(r.model).toBe("MiniMax-M2");
    expect(r.reason).toBe("heuristic");
  });

  test("never silently picks models[0] when nothing matches heuristics", () => {
    const r = selectModel(["Mystery-A", "Mystery-B"], ["Not-There"]);
    expect(r.model).toBe("Mystery-A");
    expect(r.reason).toBe("heuristic");
    const none = selectModel([], ["Not-There"]);
    expect(none).toEqual({ reason: "none" });
  });
});
