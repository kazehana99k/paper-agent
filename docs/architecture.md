# Paper Agent Architecture

## Mental Model

Paper Agent has four layers:

1. Project profile: a real LaTeX/local writing workspace, its cwd, Overleaf binding, selected agent provider, enabled modules, and quick prompts.
2. Module: reusable domain capability such as `brainstorm` or `japanese-style-rag`.
3. Agent provider: Codex, Claude Code, OpenAI-compatible API, or custom CLI.
4. Run: one agent invocation plus optional post-diff audit.

The GUI should expose profiles, providers, and modules directly. Skills are an implementation detail generated into the project-scoped Codex home for Codex runs and embedded into the portable prompt for non-Codex providers.

## Current Module Contract

Each module has:

- `module.json`: id, label, description, action ids, optional project dir.
- `SKILL.md`: module instructions when the module acts like a Codex skill.
- optional `references/`, scripts, or embedded project files.

The server reads module manifests through `/__agent/api/modules`.

## GUI Direction

The drawer header owns project selection.

The action row is for agent prompt shortcuts only:

- paper profiles: brainstorm, polish, translate, review, citecheck, compile, audit
- Japanese RAG profiles: brainstorm and audit only
- generic local profiles: brainstorm and audit

Module service actions belong in module workbenches, not in the prompt action row. This keeps module APIs from looking like editable prompt templates when their normal path does not use those prompts.

The settings modal owns profile and module configuration:

- create profile
- edit active profile
- view mounted modules
- edit prompt/skill templates
- delete profile without deleting files

Module workbenches own module-specific forms and structured state. The Japanese RAG workbench owns material import, generation, indexing, guard checks, runtime status, and recent output summaries.

## Agent Provider Contract

Provider definitions live under `config.json > agents`.

- `codex`: runs `codex exec --json` in the project cwd with isolated `CODEX_HOME`.
- `claude-code`: runs `claude --print` in the project cwd. File editing depends on the local Claude Code install and permission mode.
- `openai-compatible`: calls `/chat/completions`; returns text only unless a future tool bridge is added.
- `custom-cli`: runs a local command with prompt passed through stdin, an argv value, or a temp prompt file.

Each project stores `agentProvider`, so switching projects also switches the agent backend and prevents cross-project context bleed.

Model selection is provider-scoped. Codex models are discovered through `codex debug models`; OpenAI-compatible API models are discovered through `/v1/models`; providers without a list endpoint expose saved values and local aliases while still allowing manual entry.

## Audit Direction

Every file-changing agent run should create a before/after workspace fingerprint. If the fingerprint changes, Paper Agent runs `paper-agent-audit` in read-only mode.

Audit should distinguish:

- changes caused by the current run
- pre-existing dirty worktree state
- project boundary violations
- module-specific violations

## Japanese RAG Direction

Japanese RAG is not a separate paper project and should not be treated as a prompt-only behavior. It is an embedded Paper Agent module that can be mounted on any LaTeX/local writing profile. A paper project can feed its own `main.tex`, notes, slides, books, or papers into the module as source material.

The module must preserve these boundaries:

- style corpus: style only
- source corpus: facts only
- generated outputs: local/private unless user decides otherwise
- public manifest download: user-approved only

The module owns task and material design:

- task presets: report, literature review, research proposal
- material roles: report template, course slide, lecture note, course handout, book/textbook, academic paper, public/technical report, user note
- embedding/indexing: local JSON vectors with hash embeddings by default; heavier embedding backends are optional module configuration
- runtime: Paper Agent prepares `runtime/modules/japanese-style-rag/.venv` and runs module APIs through that runtime instead of relying on user-global `uv` or Python packages
- per-project data: module data lives under `runtime/module-data/japanese-style-rag/<projectId>` by default, so a module run does not pollute or dirty the LaTeX repository

The module source tree remains under `modules/japanese-style-rag/project`; the active project root and the module data root are passed separately at runtime.
