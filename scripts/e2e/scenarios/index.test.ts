import { describe, expect, test } from "bun:test";
import { baseScenarios, buildScenarios } from "./index";

describe("scenario set", () => {
  test("templates are unique and provider-independent", () => {
    const templates = baseScenarios();
    expect(templates.length).toBe(29);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    for (const template of templates) {
      expect(template.id.length).toBeGreaterThan(0);
      expect(template.endpoint.startsWith("/v1/")).toBe(true);
    }
  });

  test("cache semantics scenario shares the same metadata for both providers", () => {
    const templates = baseScenarios();
    const scenarios = buildScenarios(["codearts", "codebuddy"]);
    const id = "messages.usage.cache_semantics";
    const template = templates.find((t) => t.id === id);
    expect(template).toBeDefined();
    expect(template!.endpoint).toBe("/v1/messages");
    for (const provider of ["codearts", "codebuddy"] as const) {
      const bound = scenarios.find((s) => s.provider === provider && s.id === id);
      expect(bound).toBeDefined();
      expect(bound!.endpoint).toBe("/v1/messages");
      expect(bound!.feature).toBe(template!.feature);
      expect(bound!.clause).toBe(template!.clause);
    }
  });

  test("every provider gets the exact same scenario sequence and metadata", () => {
    const templates = baseScenarios();
    const scenarios = buildScenarios(["codearts", "codebuddy"]);

    for (const provider of ["codearts", "codebuddy"] as const) {
      const bound = scenarios.filter((scenario) => scenario.provider === provider);
      expect(bound.map((scenario) => scenario.id)).toEqual(templates.map((template) => template.id));
      expect(
        bound.map((scenario) => ({
          endpoint: scenario.endpoint,
          feature: scenario.feature,
          clause: scenario.clause,
          knownDefect: scenario.knownDefect,
          needsImageUrl: scenario.needsImageUrl,
        })),
      ).toEqual(
        templates.map((template) => ({
          endpoint: template.endpoint,
          feature: template.feature,
          clause: template.clause,
          knownDefect: template.knownDefect,
          needsImageUrl: template.needsImageUrl,
        })),
      );
    }

    expect(scenarios.filter((scenario) => scenario.provider === "all").map((scenario) => scenario.id)).toEqual([
      "healthz.aggregate",
    ]);
  });
});
