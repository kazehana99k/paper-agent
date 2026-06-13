# Paper Agent

Paper Agent is a local Overleaf + AI-agent workspace for research writing. It embeds an Overleaf iframe, can run Codex, Claude Code, an OpenAI-compatible API, or a custom CLI agent, and exposes project modules such as brainstorming, paper revision, citation checks, and Japanese Style RAG.

中文图文教程见 [docs/tutorial.zh-CN.md](docs/tutorial.zh-CN.md)。

## Features

- Project profiles with isolated agent settings and, for Codex, isolated `CODEX_HOME` directories.
- Overleaf project discovery: local Overleaf projects can be selected and converted into Paper Agent profiles.
- Agent providers: Codex, Claude Code, OpenAI-compatible API, and custom CLI.
- Overleaf pull/push for paper projects.
- Local-only projects for modules that do not use Overleaf.
- Built-in `brainstorm` module for turning rough ideas into paper context, claim maps, outlines, and next actions.
- Built-in `japanese-style-rag` module for Japanese course reports and explicitly enabled projects, with task presets, material-role library, embeddings, source-grounded generation, citation guards, and similarity guards.
- Quick actions submit paper/agent prompts to the selected agent. Japanese RAG status, material import, generation, indexing, and guards live in the dedicated module workbench and call the embedded module on the server.
- Post-diff audit: when an agent changes files, Paper Agent can run a read-only audit skill automatically.
- Prompt and skill templates are editable from the GUI.

## Layout

```text
paper-agent/
  lib/                            reusable project/security contracts
  public/                         browser UI
  server.js                       local server and agent runner
  modules/
    brainstorm/                   planning module
    japanese-style-rag/project/   embedded Japanese Report Style RAG project
  runtime/                        local generated agent/Codex state; ignored by git
  config.json                     local secrets/profile config; ignored by git
```

## Quick Start

```bash
cd paper-agent
npm install
cp config.example.json config.json
npm start
```

Open:

```text
http://127.0.0.1:8080/__agent/
```

Use the two floating buttons in the lower-right corner to enter separate work surfaces:

- `✳`: Agent chat, quick prompts, terminal output, and composer.
- `日`: Japanese Style RAG workbench for material import, generation, indexing, guards, and module status.

Use the project selector in the drawer header to switch profiles. Configured profiles are listed first; local Overleaf projects discovered from the Overleaf database appear below them and are converted into profiles when selected. Use the `+` button next to the selector to create a new profile manually.

New course-report projects create a local project folder, starter `main.tex`, `references.bib`, `figures/`, `materials/`, `reviews/`, `outputs/`, `.paper-agent/project.json`, and a project-local `AGENTS.md`. They also create/bind an Overleaf project by default and use `main.tex`, `references.bib`, and `figures` as the default push set.

Action buttons execute agent prompt shortcuts immediately. Hold `Shift` while clicking an action if you only want to place the generated prompt into the composer for editing. Module workbench buttons use structured forms and call module APIs directly.

## Configuration

`config.json` is intentionally ignored by git because it can contain Overleaf credentials and local absolute paths.

Important fields:

- `overleafUrl`: local Overleaf server URL.
- `email` / `password`: optional Overleaf login credentials for iframe auto-login and sync.
- `codexCmd`: compatibility alias for `agents.codex.command`.
- `agents`: provider definitions for Codex, Claude Code, API, and custom CLI.
- `projects[]`: project profiles.
- `projects[].agentProvider`: provider id used by that profile.
- `projects[].modules`: modules mounted into that profile.
- `projects[].promptSet`: quick actions shown in the GUI.
- `projects[].audit.enabled`: whether post-diff skill audit runs after agent changes files.

Provider notes:

- `codex` uses `codex exec --json` in the project directory and a project-scoped `CODEX_HOME`.
- `claude` uses `claude --print` in the project directory. It can edit local files when your Claude Code install and permission mode allow it.
- `api` calls an OpenAI-compatible `/chat/completions` endpoint. It returns text only; it does not edit files unless you later add a tool bridge.
- `custom` runs any local command. Use `promptMode` as `stdin`, `arg`, or `file`; argument templates can use `{{cwd}}` and `{{promptFile}}`.

The settings UI keeps Codex and Claude Code simple: choose the provider and model. API-specific fields are shown only for the API provider. Model suggestions are fetched from `codex debug models` for Codex and `/v1/models` for OpenAI-compatible API providers.

## Japanese Style RAG Module

The embedded module lives at:

```text
modules/japanese-style-rag/project
```

This is a Paper Agent module, not a Codex skill and not a separate paper project. It exposes server APIs for status, material import, indexing, generation, source search, latest output, and guards. Paper Agent prepares a module-owned Python venv under `runtime/modules/japanese-style-rag/.venv` and runs the package with JSON vector indexes by default. Embeddings are configured through `JSTYLE_EMBEDDING_MODEL` and default to an OpenAI-compatible local endpoint (`openai:qwen3-embedding` at `http://127.0.0.1:8001/v1`); set `JSTYLE_ALLOW_HASH_EMBEDDINGS=1` or `JSTYLE_EMBEDDING_MODEL=hash` for a no-model fallback.

In the GUI, report projects enable the Japanese Style RAG workbench by default. Other project types can enable the module explicitly. The active LaTeX/local project remains the host project; the workbench owns the material library, task form, index builder, guard runner, and runtime status. Relative material paths such as `main.tex` are resolved from the active project directory, so a paper project can feed its own LaTeX draft into the module when the module is enabled.

## Overleaf Sync Safety

Each project folder has `.paper-agent/project.json`. Pull and push operations check this marker before writing files, and append audit records to `.paper-agent/sync-log.jsonl`.

Push paths are allowlisted project-relative paths. Absolute paths, `..`, hidden files, `.paper-agent`, `.git`, `.env`, `node_modules`, runtime data, and unsupported extensions are rejected. Directory push paths such as `figures` are expanded recursively.

Pull skips files outside the writing whitelist. This protects local project metadata and scripts from accidental Overleaf zip overwrite.

Per-project module data is stored under the active project:

```text
<project>/.paper-agent/modules/japanese-style-rag/
```

This keeps the material library, indexes, embeddings, and latest generated drafts stable across refreshes and project switches. The scaffolded project `.gitignore` excludes `.paper-agent/modules/` by default, because course PDFs, source corpora, embeddings, and generated drafts are usually private and should not be pushed to GitHub accidentally.

The module treats:

- `data/style_corpus/raw/` as style-only material.
- `data/source_corpus/raw/` as the only factual source corpus.

Source materials are role-separated:

- `templates/`: report templates and rubrics; structure only, not factual evidence.
- `course_slides/`, `lecture_notes/`, `course_handouts/`: course context and assignment framing.
- `books/`: concepts and theory framework.
- `papers/`: prior research.
- `reports/`: public, technical, or institutional background.
- `user_notes/`: the user's viewpoint and notes.

Raw corpora, generated outputs, indexes, profiles, and local virtual environments are ignored by git. Keep private reports, course materials, and generated drafts out of the public repository.

Typical commands:

```bash
cd modules/japanese-style-rag/project
uv sync --extra dev
uv run pytest
uv run python scripts/eval_guardrails.py
```

Fallback without `uv`:

```bash
PYTHONPATH=src python -m pytest
PYTHONPATH=src python scripts/eval_guardrails.py
```

## GitHub Hygiene

Before publishing, verify:

- `config.json` is not staged.
- `runtime/`, `node_modules/`, `server.log`, and `backups/` are not staged.
- Japanese RAG raw corpora and generated outputs are not staged.
- No Overleaf password, API key, session, local auth file, or private document is committed.

Before packaging:

```bash
npm test
npm pack --dry-run --json
```

The package uses a `files` allowlist plus `.npmignore` to keep runtime data, private config, `.codex`, caches, corpora, and generated outputs out of the npm tarball.
