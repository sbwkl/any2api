# 领域文档

工程技能探索代码库时如何消费本仓库的领域文档。

## 探索前先读

- 根目录 **`GLOSSARY.md`**（单上下文仓库，无 `GLOSSARY-MAP.md`）。
- **`docs/design-docs/adr/`**：与本领域相关的 ADR。这是本项目的 ADR 目录约定，取代技能模板默认的 `docs/adr/`。
- **`docs/design-docs/index.md`**：设计知识库索引与当前事实源指针。

文件不存在时静默继续：不提示、不主动创建；由 `/domain-modeling` 在术语或决策真正定稿时惰性创建。

## 文件结构（单上下文）

```
/
├── GLOSSARY.md
├── docs/design-docs/adr/
└── src/
```

## 使用术语

输出中的领域概念（issue 标题、重构提案、假设、测试名）必须使用 `GLOSSARY.md` 定义的术语，不用其明确回避的同义词。术语缺失是信号：要么在发明项目不用的语言（重新考虑），要么是真空白（留给 `/domain-modeling`）。

## 标记 ADR 冲突

输出与既有 ADR 矛盾时显式指出，不静默覆盖：

> _与 ADR-xxxx（决策名）矛盾，但值得重开，因为…_
