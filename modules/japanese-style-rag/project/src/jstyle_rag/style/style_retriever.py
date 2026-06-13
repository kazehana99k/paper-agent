from __future__ import annotations

from typing import Any

from jstyle_rag.config import AppConfig

from .style_index import retrieve_style_profiles


def retrieve_abstract_style_advice(
    topic: str,
    discipline: str | None = None,
    target_style: str | None = None,
    top_k: int = 3,
    config: AppConfig | None = None,
) -> list[dict[str, Any]]:
    """Return abstract style advice only. Original report sentences are never returned."""
    profiles = retrieve_style_profiles(topic, discipline, target_style, top_k, config)
    advice: list[dict[str, Any]] = []
    for profile in profiles:
        advice.append(
            {
                "style_id": profile["style_id"],
                "score": profile["score"],
                "doc_type": profile["doc_type"],
                "discipline": profile["discipline"],
                "tone": profile["tone"],
                "style_summary_ja": profile["style_summary_ja"],
                "paragraph_length_pattern": profile["paragraph_length_pattern"],
                "sentence_ending_pattern": profile["sentence_ending_pattern"],
                "connective_pattern": profile["connective_pattern"],
                "structure_pattern": profile["structure_pattern"],
                "anti_ai_notes": profile["anti_ai_notes"],
            }
        )
    return advice
