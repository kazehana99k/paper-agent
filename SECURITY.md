# Security Policy

Paper Agent is a local-first writing tool. It can launch Codex, Claude Code, custom CLI commands, Python module code, and Overleaf sync operations from the current user account. Do not expose it to the public internet.

## Supported Use

- Bind the server to `127.0.0.1` only.
- Use it on a trusted local machine.
- Keep credentials in `config.json` or environment variables out of git.
- Treat uploaded materials, runtime data, and generated outputs as private project data.

## Local API Protection

The app issues an in-memory local access token at startup. Browser API calls and the WebSocket runner must send this token. This reduces cross-site requests from unrelated web pages, but it is not a multi-user authentication system.

Known boundary: the app currently serves the Paper Agent UI and the local Overleaf proxy under the same localhost origin. Do not load untrusted Overleaf content or expose the proxy to other users.

## High-Risk Capabilities

- Codex runs with `danger-full-access` because Paper Agent is designed to edit local LaTeX projects and run local checks.
- Claude Code and custom CLI providers can execute local commands if configured.
- Pull/push synchronizes files with Overleaf. Project markers and path allowlists are used to reduce accidental cross-project writes.
- Japanese Style RAG imports local files into the project module data directory. Only import materials you are allowed to use.

## Reporting Issues

Open a GitHub issue with:

- affected version or commit,
- exact endpoint or workflow,
- impact,
- minimal reproduction,
- whether secrets or private materials were exposed.

Do not include API keys, passwords, private documents, or Overleaf cookies in public reports.
