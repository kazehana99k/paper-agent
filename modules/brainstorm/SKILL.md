---
name: paper-agent-brainstorm
description: Research and writing planning module for Paper Agent. Use when the user asks to brainstorm a paper, clarify an unclear idea, plan a manuscript, structure a research story, build a project context, compare possible contributions, or turn notes into an actionable writing plan.
---

# Paper Agent Brainstorm

Use this module before drafting when the user has ideas, notes, experiments, or source material but the paper story is still underspecified.

## Output Contract

Produce durable planning artifacts under `work/brainstorm/` unless the user asks for a chat-only answer:

- `project_context.md`: problem, gap, core claim, contribution name, evidence inventory, constraints, open risks.
- `claim_map.md`: claims, required evidence, available evidence, missing evidence, citation needs.
- `outline.md`: section-level outline with paragraph jobs, not decorative headings.
- `next_actions.md`: concrete tasks sorted by unblock order.

## Workflow

1. Read the nearest `AGENTS.md` and project module rules.
2. Collect source context from user notes, current manuscript, experiment logs, or local RAG outputs.
3. Separate known facts, user assumptions, model inferences, and unresolved questions.
4. Name the central contribution in 2-4 words. Treat the name as a working handle, not branding.
5. Build the argument around falsifiable claims and the evidence needed to defend them.
6. Preserve honesty constraints: do not invent metrics, citations, baselines, or publication facts.
7. When Japanese Style RAG is involved, use style profiles only for prose shape and source corpus only for facts.

## References

Read `references/research-brainstorm.md` for the detailed question sequence when the project is early, vague, or contentious.
