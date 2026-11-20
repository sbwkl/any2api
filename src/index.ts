// any2api — 各工具的 2Api 适配器注册入口
// 每个适配器是一个独立 provider（src/providers/<name>/），对外统一暴露 OpenAI 兼容 API。
// 当前 provider：codearts（码道 CodeArts Agent）；后续：codebuddy 等。
import { start as startCodearts } from "./providers/codearts";

startCodearts().catch((e) => {
  console.error(`[any2api] codearts provider 启动失败: ${e?.message ?? e}`);
  process.exit(1);
});
