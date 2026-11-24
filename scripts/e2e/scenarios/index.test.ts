import { describe, expect, test } from "bun:test";
import { baseScenarios, buildScenarios } from "./index";

describe("scenario set", () => {
  test("templates are unique and provider-independent", () => {
    const templates = baseScenarios();
    expect(templates.length).toBe(28);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    for (const template of templates) {
      expect(template.id.length).toBeGreaterThan(0);
      expect(template.endpoint.startsWith("/v1/")).toBe(true);
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
