import type { ProviderName } from "../types";
import { anthropicScenarios } from "./anthropic";
import { chatScenarios } from "./chat";
import { healthzScenario, modelListScenario } from "./meta";
import { responsesScenarios } from "./responses";
import type { Scenario } from "./shared";

export function buildScenarios(providers: ProviderName[]): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const provider of providers) {
    scenarios.push(
      ...chatScenarios(provider),
      ...anthropicScenarios(provider),
      ...responsesScenarios(provider),
      modelListScenario(provider),
    );
  }
  scenarios.push(healthzScenario());
  return scenarios;
}

export type { Scenario, ScenarioContext, Verdict } from "./shared";
