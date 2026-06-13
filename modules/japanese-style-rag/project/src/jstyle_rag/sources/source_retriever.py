from __future__ import annotations

from typing import Any

from jstyle_rag.config import AppConfig

from .source_index import retrieve_source_chunks


def retrieve_sources(
    topic: str,
    top_k: int = 6,
    source_type: str | None = None,
    citation_role: str | None = None,
    config: AppConfig | None = None,
) -> list[dict[str, Any]]:
    chunks = retrieve_source_chunks(
        topic,
        top_k=top_k if source_type or citation_role else top_k + 4,
        source_type=source_type,
        citation_role=citation_role,
        config=config,
    )
    if source_type or citation_role:
        return chunks[:top_k]
    factual = [
        chunk
        for chunk in chunks
        if chunk.get("source_type") != "report_template"
        and chunk.get("citation_role") != "template_structure"
    ]
    return factual[:top_k]


def retrieve_report_templates(
    topic: str,
    top_k: int = 2,
    config: AppConfig | None = None,
) -> list[dict[str, Any]]:
    return retrieve_source_chunks(
        topic,
        top_k=top_k,
        source_type="report_template",
        config=config,
    )
