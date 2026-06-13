# Paper Agent Security Audit

Date: 2026-06-14

## Executive Summary

Paper Agent is a local-only app, but it can trigger powerful actions: local agent execution, Overleaf pull/push, file imports, and Python module jobs. The most important release blockers were unauthenticated localhost mutation APIs, project-crossing sync risk, unsafe sync paths, and packaging of runtime/dev residue.

This audit is based on the Express, frontend JavaScript, and FastAPI/Python security guidance used during the engineering pass.

## Fixed in This Pass

### S-001 Local API and WebSocket lacked a request token

- Severity: High
- Location: `server.js` API and `/__agent/pty` WebSocket entrypoints
- Impact: unrelated local web pages or local processes could attempt to trigger agent and sync actions.
- Fix: added `lib/local-auth.js`; the UI fetches `/__agent/api/session`, then sends `X-Paper-Agent-Token` on API calls and `?token=` on the WebSocket.
- Residual risk: Paper Agent UI and local Overleaf proxy still share an origin. Do not load untrusted Overleaf content or expose the service beyond loopback.

### S-002 Pull/push depended on global `activeProjectId`

- Severity: High
- Location: `pullProject`, `pushProject`, prompt rendering, JStyle APIs, WebSocket prompt runner
- Impact: switching projects in another tab could run sync or agent work against the wrong project.
- Fix: mutation endpoints and WebSocket prompt messages now accept `projectId`; frontend attaches the active project id to project-scoped calls.

### S-003 Overleaf sync could cross project boundaries

- Severity: High
- Location: project creation and sync flow
- Impact: a project could pull/push from a mismatched Overleaf binding into a local directory that belonged to another Paper Agent project.
- Fix: each project folder gets `.paper-agent/project.json`; pull/push check the marker before writing and record `.paper-agent/sync-log.jsonl`.

### S-004 Push paths were not constrained to project files

- Severity: High
- Location: `pushProject`
- Impact: absolute paths or `..` segments could read files outside the project and upload them to Overleaf.
- Fix: sync paths are normalized as project-relative paths; hidden/control directories are denied; unsupported file extensions are rejected; directory paths are expanded safely.

### S-005 Pull wrote every zip entry into the project root

- Severity: Medium
- Location: `pullProject`
- Impact: a wrong or hostile Overleaf zip could overwrite local control files.
- Fix: pull skips dotfiles, Paper Agent metadata, runtime/control paths, and unsupported extensions.

### S-006 Public config could expose future secrets

- Severity: Medium
- Location: `/__agent/api/config`
- Impact: if an agent provider later stored `apiKey`, the UI config response could expose it.
- Fix: public agent config is sanitized; secret-like fields are replaced with `hasSecret`.

### S-007 Package would include runtime/dev residue

- Severity: Medium
- Location: `package.json`, generated module folders
- Impact: npm/GitHub packaging could include `.codex`, caches, runtime data, or private outputs.
- Fix: added `files` allowlist, `.npmignore`, MIT license, security/contributing docs, and removed generated caches from the embedded module tree.

## Remaining Risks

### R-001 Same-origin Overleaf proxy

- Severity: Medium
- Recommendation: eventually serve Paper Agent UI/API on a separate local origin from the Overleaf proxy, or add a stricter frame/proxy boundary. The current token blocks cross-origin CSRF but does not protect against same-origin script execution from proxied Overleaf content.

### R-002 Agent providers execute local commands

- Severity: Medium to High by configuration
- Recommendation: introduce a provider capability registry. Keep custom CLI disabled unless configured, show a warning before enabling it, and consider command allowlists for shared machines.

### R-003 Multipart upload parser is intentionally minimal

- Severity: Medium
- Recommendation: replace the current in-memory parser with a streaming upload library before supporting large public workflows. Keep the app local-only meanwhile.

### R-004 External absolute material imports remain allowed

- Severity: Medium
- Recommendation: keep absolute path import in the advanced UI for local power users, but add a “trusted external path” policy if Paper Agent is ever used by multiple people.
