# e2e 基线

- 生成时间：2026-11-24T11:01:41.519Z
- 目标：http://127.0.0.1:52841
- 调用预算：50/60
- 模型：codearts=glm-5.3-flash，codebuddy=glm-5.3-flash
- 场景集：codearts 28/28；codebuddy 28/28
- 汇总：pass 32 / fail 17 / not-supported 4 / skipped 4
- 人类可读报告：[e2e-baseline.html](e2e-baseline.html)（下载后用浏览器打开；GitHub 不渲染 HTML）
- 机器可读数据：[e2e-baseline.json](e2e-baseline.json)（含入站请求、上游请求与响应原文）
- 再生成：`E2E_MAX_CALLS=60 E2E_RECORD=1 bun run e2e --baseline`

本文件只是入口；场景明细与证据见 HTML/JSON，不在此重复矩阵。
