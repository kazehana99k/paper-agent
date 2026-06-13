# AGENTS.md

Guidance for Codex and other coding agents working in this repository.

## Project Boundary

This project is a local Japanese Report Style RAG module for Paper Agent. It is not a plagiarism, rewriting, academic-check bypass, or report-copying tool.

The `data/style_corpus/raw/` files are only for extracting abstract style profiles. They must never be used as factual source material for generated drafts.

Generated report content may use only:

- abstract style profiles
- user-provided source corpus in `data/source_corpus/raw/`
- explicit user requirements and viewpoints

## Module Roles

This repository should be treated as a Paper Agent module, not as a Codex skill. Agent prompts may call the module APIs, but the module itself owns task presets, material roles, embedding/indexing, generation, and guard logic.

For report tasks, keep material roles separate:

- `report_template`: structure/rubric only, not factual evidence
- `course_slide`, `lecture_note`, `course_handout`: course context and assignment framing
- `book`: concepts and theory framework
- `academic_paper`: prior research
- `government_report`, `technical_report`, `white_paper`, `industry_report`: factual background, statistics, technical trends
- `user_note`: user's viewpoint and notes

## Engineering Rules

- Keep all features MVP-first.
- Do not introduce heavyweight frameworks unless there is a concrete need.
- Do not automatically crawl, scrape, or import reports or academic papers.
- A manually reviewed public-source manifest such as `data/source_corpus/public_sources.json` may be downloaded only after the user has approved using those public/official URLs.
- Do not add piracy-oriented, leaked-document, or unauthorized-document workflows.
- Do not implement academic-check bypass or plagiarism features.
- Do not preserve long passages from style corpus in profiles, prompts, logs, or outputs.
- All generation paths must pass through `citation_guard` and `similarity_guard`.
- Tests must remain runnable locally with the deterministic hash embedding fallback.

## Source and Citation Rules

- `style_corpus` is for style only.
- `source_corpus` is the only corpus that may support facts, years, statistics, definitions, paper titles, and citations.
- If a factual claim is not supported by retrieved source chunks, mark it with `[要出典確認]`.
- Never fabricate authors, years, statistics, titles, or reference lists.
- Distinguish source roles: academic papers support prior research; public reports and white papers support background, statistics, and technical trends; lecture notes support course context.
- Report templates support only structure and grading expectations; do not cite them as factual evidence.

## Local Execution

Paper Agent prepares its own module runtime under `paper-agent/runtime/modules/japanese-style-rag/.venv` and runs hash embeddings + JSON vectors by default. Standalone development may still use `uv`:

```bash
uv sync --extra dev
uv run pytest
uv run python scripts/eval_guardrails.py
```

If dependencies are unavailable, tests should still run with:

```bash
PYTHONPATH=src python -m pytest
PYTHONPATH=src python scripts/eval_guardrails.py
```
