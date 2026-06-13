# japanese-report-style-rag

Local Japanese Report Style RAG module for drafting Japanese university reports, research proposals, and literature review notes with strict source grounding.

This is a Style RAG system, not a plagiarism tool. Files under `data/style_corpus/raw/` are used only to extract abstract style profiles. They are not used as factual sources, and their original sentences must not be copied into generated drafts. Concrete facts, definitions, authors, years, statistics, and paper titles may come only from `data/source_corpus/raw/` or explicit user input.

Do not upload private reports, leaked documents, pirated papers, or unauthorized course materials to cloud services. This MVP does not crawl the web or scrape report sites. It can optionally download a small, manually reviewed manifest of public/official sources after you inspect `data/source_corpus/public_sources.json`.

## Paper Agent Module

Inside Paper Agent this project is a first-class module, not a Codex skill. The module owns:

- task presets: `report`, `literature_review`, `research_proposal`
- material roles: report templates, course slides, lecture notes, course handouts, books, academic papers, public reports, and user notes
- local embedding/vector indexing with hash embeddings + JSON vectors by default
- guarded generation through citation and similarity checks

Paper Agent creates and uses `paper-agent/runtime/modules/japanese-style-rag/.venv` for module execution. The default module path does not require a user-global `uv` install.

## What It Does

- Extracts abstract style profiles from local Japanese report samples.
- Builds a local style index for style advice only.
- Ingests role-tagged source documents for factual retrieval.
- Generates report drafts through offline fallback, Ollama, or an OpenAI-compatible chat API.
- Runs every generated draft through citation and similarity guards.
- Exposes CLI, FastAPI endpoints, and Paper Agent module APIs.

## Install

```bash
cd japanese-report-style-rag
uv sync --extra dev
```

If you want the smallest offline smoke test without installing all optional runtime dependencies:

```bash
PYTHONPATH=src python -m pytest
```

## Directory Roles

```text
data/style_corpus/raw/        style samples only; never factual sources
data/style_corpus/profiles/   abstract JSONL style profiles
data/style_corpus/index/      style profile vectors and similarity-check vectors
data/source_corpus/raw/       real source materials you are allowed to cite
data/source_corpus/processed/ source chunks
data/source_corpus/index/     source vectors
data/outputs/                 generated JSON outputs
```

Recommended raw source subdirectories:

```text
data/source_corpus/raw/templates/         report template / rubric; structure only
data/source_corpus/raw/course_slides/     course slides
data/source_corpus/raw/lecture_notes/     lecture notes
data/source_corpus/raw/course_handouts/   assignment handouts
data/source_corpus/raw/books/             books / textbooks
data/source_corpus/raw/papers/            academic papers
data/source_corpus/raw/reports/           public or technical reports
data/source_corpus/raw/user_notes/        user viewpoints and notes
```

Source files are classified during ingest with coarse metadata:

- `academic_paper`: prior research
- `course_slide`, `lecture_note`, `course_handout`: course context and assignment framing
- `book`: concepts and theory framework
- `report_template`: structure and rubric only, not factual evidence
- `government_report`, `technical_report`, `white_paper`, `industry_report`: factual background, statistics, or technical overview
- `user_note`: user-provided viewpoint

For ambiguous files, create `filename.ext.meta.json` next to the source file:

```json
{
  "source_type": "government_report",
  "authority_level": "official",
  "citation_role": "statistics"
}
```

## Basic Workflow

Put local style samples in `data/style_corpus/raw/` as `.txt`, `.md`, or `.pdf`. Do not add documents you are not authorized to use.

```bash
uv run jstyle seed-style-profiles
uv run jstyle ingest-style
uv run jstyle build-style-index
```

`seed-style-profiles` creates abstract, synthetic style profiles for common Japanese university report tasks. It does not store or copy anyone's report text. Use it when you do not have clearly authorized student report samples.

Put real source materials in `data/source_corpus/raw/`.

```bash
uv run jstyle classify-sources
uv run jstyle write-source-meta reports/network.pdf \
  --source-type government_report \
  --authority-level official \
  --citation-role statistics
uv run jstyle ingest-sources
uv run jstyle build-source-index
```

## Curated Public Source Manifest

`data/source_corpus/public_sources.json` contains a small manually curated starter corpus for information-network/security topics. It includes official/institutional technical reports from IPA and JPCERT/CC, plus arXiv preprints/white papers for prior-research or technical-overview use. These are not student reports and should not be used as style samples.

Download the listed public sources only after reviewing the manifest:

```bash
uv run python scripts/download_public_sources.py
uv run jstyle ingest-sources
uv run jstyle build-source-index
```

Fallback without `uv`:

```bash
python scripts/download_public_sources.py
python -m pip install pypdf cryptography
PYTHONPATH=src JSTYLE_EMBEDDING_MODEL=hash JSTYLE_VECTOR_BACKEND=json python -m jstyle_rag.cli ingest-sources
PYTHONPATH=src JSTYLE_EMBEDDING_MODEL=hash JSTYLE_VECTOR_BACKEND=json python -m jstyle_rag.cli build-source-index
```

Current starter manifest size: 11 PDFs. In the verified local setup, they ingested into 1803 source chunks and 1803 JSON vector records. Treat arXiv entries as `preprint`, not peer-reviewed publications, unless you independently confirm their publication status.

Generate a draft:

```bash
uv run jstyle generate \
  --topic "SNSが若者のコミュニケーションに与える影響" \
  --word-count 1600 \
  --discipline sociology \
  --target-style undergraduate_report \
  --requirements "一般教養科目のレポート" \
  --user-point "SNSは便利だが、対面関係への影響もあると思う"
```

The default provider is `offline`, which creates a conservative local draft and still runs guards. Set `JSTYLE_LLM_PROVIDER` to use a model server.

## Ollama

Start Ollama locally, then set:

```bash
export JSTYLE_LLM_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.1
uv run jstyle generate --topic "..." --discipline sociology --target-style undergraduate_report
```

## OpenAI-Compatible API

Use any local or hosted OpenAI-compatible chat endpoint:

```bash
export JSTYLE_LLM_PROVIDER=openai-compatible
export OPENAI_BASE_URL=http://localhost:8000/v1
# Set OPENAI_API_KEY in your shell if your provider requires it.
export OPENAI_MODEL=gpt-4o-mini
uv run jstyle generate --topic "..." --discipline sociology --target-style undergraduate_report
```

The prompt explicitly tells the model that style profiles are not content sources, source corpus is required for concrete facts, and unsupported factual claims must be marked `[要出典確認]`.

## API

```bash
uv run jstyle serve
```

Default URL: `http://127.0.0.1:8008`

Endpoints:

```http
POST /retrieve-style
POST /retrieve-sources
POST /generate-report
POST /check-citations
POST /check-similarity
```

Example:

```bash
curl -X POST http://127.0.0.1:8008/generate-report \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "SNSが若者のコミュニケーションに与える影響",
    "word_count": 1600,
    "discipline": "sociology",
    "target_style": "undergraduate_report",
    "requirements": "一般教養科目のレポート",
    "user_points": ["SNSは便利だが、対面関係への影響もあると思う"]
  }'
```

## Custom GPT Action

For personal testing, expose the local FastAPI endpoint with a tunnel and point a Custom GPT Action schema at the public URL.

ngrok:

```bash
ngrok http 8008
```

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8008
```

Use tunnels only for personal testing. Do not expose private reports, unauthorized samples, or source documents.

## Vector Backend

The default backend is local JSON vectors:

```bash
export JSTYLE_VECTOR_BACKEND=json
```

Chroma is supported when `chromadb` is installed:

```bash
export JSTYLE_VECTOR_BACKEND=chroma
```

Embeddings support three local modes:

```bash
# Recommended for Paper Agent: llama.cpp OpenAI-compatible embeddings.
export JSTYLE_EMBEDDING_MODEL=openai:qwen3-embedding
export JSTYLE_EMBEDDING_BASE_URL=http://127.0.0.1:8001/v1
export JSTYLE_ALLOW_HASH_EMBEDDINGS=0

# Optional offline fallback for development.
export JSTYLE_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

# Deterministic smoke-test fallback only; not suitable for real retrieval quality.
export JSTYLE_EMBEDDING_MODEL=hash
export JSTYLE_ALLOW_HASH_EMBEDDINGS=1
```

For llama.cpp, start a separate embedding server, for example:

```bash
llama-server -hf Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0 \
  --host 127.0.0.1 --port 8001 \
  -a qwen3-embedding \
  --embedding --pooling last -ub 8192
```

## Tests

```bash
uv run pytest
uv run python scripts/eval_guardrails.py
```

Fallback:

```bash
PYTHONPATH=src python -m pytest
PYTHONPATH=src python scripts/eval_guardrails.py
```

## Environment Fallback TODO

If `uv` is not installed in the execution environment, install it first and then run:

```bash
uv sync --extra dev
uv run pytest
```

If the environment is offline, keep using the JSON vector backend and hash embedding fallback for tests. Full runtime use with `sentence-transformers`, Chroma, FastAPI, and Typer still requires installing the dependencies declared in `pyproject.toml`.
