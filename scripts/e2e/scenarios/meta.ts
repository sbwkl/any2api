import { httpRequest } from "../http";
import type { ProviderName } from "../types";
import { checkModels } from "../verify";
import { assess, call, fail, jsonOf, pass, type Scenario } from "./shared";

export function modelListScenario(provider: ProviderName): Scenario {
  return {
    id: "models.list",
    provider,
    endpoint: "/v1/models",
    feature: "模型列表形状",
    clause: "OAI-MODEL-01",
    needsModel: false,
    run: async (ctx) => {
      const res = await call(ctx, "/v1/models");
      const { json, error } = jsonOf(res);
      if (error) return fail(`HTTP ${res.status}；${error}`);
      return assess(res, checkModels(json));
    },
  };
}

export function healthzScenario(): Scenario {
  return {
    id: "healthz.aggregate",
    provider: "all",
    endpoint: "/healthz",
    feature: "聚合健康检查",
    needsModel: false,
    needsProvider: false,
    run: async (ctx) => {
      const res = await httpRequest(ctx.baseUrl, "/healthz", { timeoutMs: ctx.timeoutMs });
      const { json, error } = jsonOf(res);
      if (res.status !== 200) return fail(`HTTP ${res.status}：${res.text.slice(0, 160)}`);
      if (error) return fail(error);
      if (json?.ok !== true) return fail(`ok 字段为 ${String(json?.ok)}`);
      if (!Array.isArray(json?.providers)) return fail("providers 不是数组");
      return pass(`HTTP 200；${json.providers.length} 个 provider`);
    },
  };
}
