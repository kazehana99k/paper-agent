# Contributing

Paper Agent is organized as a local app plus project modules.

## Development Setup

```bash
npm install
npm test
```

For the Japanese Style RAG module:

```bash
cd modules/japanese-style-rag/project
PYTHONPATH=src python -m pytest
```

Use the module-local virtual environment when available:

```bash
../../runtime/modules/japanese-style-rag/.venv/bin/python -m pytest
```

## Engineering Rules

- Keep `server.js` focused on route wiring; move reusable policy and contract logic into `lib/`.
- Keep runtime data out of git: `runtime/`, `projects/`, `backups/`, `config.json`, `.env`, uploaded corpora, generated outputs.
- Project actions must accept an explicit `projectId` when they can mutate files, call agents, or run module jobs.
- Overleaf sync must pass project marker checks and path allowlists.
- Japanese Style RAG is a module, not a global Codex skill. Its data belongs under the active project module data root.
- Do not commit secrets, cookies, API keys, private course materials, or generated vector stores.

## Pull Request Checklist

- `npm test` passes.
- Python module tests pass when the change touches `modules/japanese-style-rag/project`.
- `npm pack --dry-run --json` does not include runtime data, `.codex`, `__pycache__`, private configs, or uploaded materials.
- UI text remains understandable for non-engineering users.
- Report and paper workflows remain separate.
