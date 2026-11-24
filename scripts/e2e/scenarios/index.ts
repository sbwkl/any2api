import type { ProviderName } from "../types";
import { anthropicScenarios } from "./anthropic";
import { chatScenarios } from "./chat";
import { healthzScenario, modelListScenario } from "./meta";
import { responsesScenarios } from "./responses";
import type { Scenario, ScenarioTemplate } from "./shared";

export function baseScenarios(): ScenarioTemplate[] {
  return [
    ...chatScenarios(),
    ...anthropicScenarios(),
    ...responsesScenarios(),
    modelListScenario(),
  ];
}

export function buildScenarios(providers: ProviderName[]): Scenario[] {
  const templates = baseScenarios();
  const scenarios: Scenario[] = [];
  for (const provider of providers) {
    for (const template of templates) {
      scenarios.push({ ...template, provider });
    }
  }
  scenarios.push(healthzScenario());
  return scenarios;
}

export type { Scenario, ScenarioContext, ScenarioTemplate, Verdict } from "./shared";
