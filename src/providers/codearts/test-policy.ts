// 实测 Policy Center policy/bundle — 模型列表发现端点
import { loadCredentials } from "./config";
import { signSh } from "./signer";
import { uuid32 } from "../../shared/ids";

async function main(): Promise<void> {
  const creds = loadCredentials();
  const url = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/policy/bundle";
  const body = {
    ide: "CodeArts Agent",
    application: "CodeArts Agent",
    plugin_name: "snap_vscode",
    plugin_version: "5.0.0",
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Language": "zh-cn",
    "x-snap-traceid": uuid32(),
    "Agent-Type": "PromptCenter",
    "x-auth-token": "",
  };
  const signed = signSh({ method: "POST", endpoint: url, data: body, headers }, creds);
  const resp = await fetch(url, { method: "POST", headers: signed, body: JSON.stringify(body) });
  console.log("status:", resp.status);
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    const s = JSON.stringify(json);
    console.log("resp size:", s.length);
    const cfg = json?.plugin_config ?? json?.result?.plugin_config;
    if (cfg) {
      for (const item of Array.isArray(cfg) ? cfg : [cfg]) {
        const c = typeof item?.config === "string" ? JSON.parse(item.config) : item?.config;
        if (Array.isArray(c)) {
          for (const cc of c) {
            if (cc?.user_model_list) {
              console.log("=== user_model_list ===");
              for (const m of cc.user_model_list)
                console.log(`${m.model_id}  ${m.model_name ?? ""}  pri=${m.priority ?? ""} in=${m.input_length ?? ""}`);
            }
          }
        }
      }
    } else console.log(s.slice(0, 600));
  } catch { console.log(text.slice(0, 600)); }
}
main();
