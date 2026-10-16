# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

本仓库的域文档布局已在初始化时与用户确认为 **single-context**：一个仓库共用一份根目录的 `GLOSSARY.md`，架构决定放 `docs/adr/`。没有 `GLOSSARY-MAP.md`，也没有按子项目拆分的 context。（本次初始化未创建任何域文件——按需创建，见下。）

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic. _(本仓库为 single-context，不存在此文件。)_
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. _(本仓库无 `src/<context>/docs/adr/` 这类 context-scoped ADR 目录。)_

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved — 包括第一次真正写下词条时才创建根目录 `GLOSSARY.md`。

## File structure

This repo uses the single-context layout:

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

(Multi-context repos would have a root `GLOSSARY-MAP.md`; this repo does not and is not expected to.)

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
