from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from jstyle_rag.config import AppConfig, ensure_directories, get_config
from jstyle_rag.sources.citation_guard import check_citations
from jstyle_rag.sources.source_retriever import retrieve_report_templates, retrieve_sources
from jstyle_rag.style.similarity_guard import check_similarity
from jstyle_rag.style.style_index import load_style_raw_chunks
from jstyle_rag.style.style_retriever import retrieve_abstract_style_advice

from .anti_ai_editor import soften_ai_repetition
from .generator import ReportGenerator
from .prompt_builder import build_report_prompt


def generate_report(
    topic: str,
    word_count: int,
    discipline: str,
    target_style: str,
    requirements: str = "",
    user_points: list[str] | None = None,
    top_k_style: int = 3,
    top_k_sources: int = 6,
    top_k_templates: int = 2,
    save: bool = False,
    config: AppConfig | None = None,
) -> dict[str, Any]:
    cfg = config or get_config()
    ensure_directories(cfg)
    style_profiles = retrieve_abstract_style_advice(
        topic=topic,
        discipline=discipline,
        target_style=target_style,
        top_k=top_k_style,
        config=cfg,
    )
    template_chunks = retrieve_report_templates(topic, top_k=top_k_templates, config=cfg)
    sources = retrieve_sources(topic, top_k=top_k_sources, config=cfg)
    prompt = build_report_prompt(
        topic=topic,
        word_count=word_count,
        discipline=discipline,
        target_style=target_style,
        requirements=requirements,
        user_points=user_points or [],
        style_profiles=style_profiles,
        template_chunks=template_chunks,
        source_chunks=sources,
    )
    generated = ReportGenerator(cfg).generate(
        prompt=prompt,
        topic=topic,
        word_count=word_count,
        requirements=requirements,
        user_points=user_points or [],
        source_chunks=sources,
    )
    edited_draft = soften_ai_repetition(generated.draft)
    citation_result = check_citations(edited_draft, sources)
    similarity_warnings = check_similarity(
        citation_result.text,
        style_chunks=load_style_raw_chunks(cfg),
    )
    result = {
        "outline": generated.outline,
        "draft": citation_result.text,
        "citation_warnings": [warning.to_dict() for warning in citation_result.warnings],
        "similarity_warnings": [warning.to_dict() for warning in similarity_warnings],
        "style_profiles_used": style_profiles,
        "templates_used": template_chunks,
        "sources_used": sources,
        "prompt": prompt,
    }
    if save:
        output_path = save_report_output(result, cfg.outputs_dir)
        result["output_file"] = str(output_path)
    return result


def save_report_output(result: dict[str, Any], outputs_dir: Path) -> Path:
    outputs_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = outputs_dir / f"report-{timestamp}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
