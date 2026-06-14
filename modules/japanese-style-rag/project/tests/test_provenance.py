from __future__ import annotations

import json
from pathlib import Path

import pytest

from jstyle_rag.config import ensure_directories, get_config
from jstyle_rag.generation.provenance import build_paragraph_sources, build_run_manifest
from jstyle_rag.sources.source_index import build_source_index, retrieve_source_chunks
from jstyle_rag.sources.source_ingest import ingest_sources


def test_paragraph_sources_bind_factual_chunks_not_templates() -> None:
    paragraph = "部分トレースの定義は、複合系の一部を消去して部分系の状態を得る操作である。"
    sources = [
        {
            "chunk_id": "template-1",
            "source_file": "templates/old-report.txt",
            "source_type": "report_template",
            "citation_role": "template_structure",
            "text": "部分トレースの定義を書く。",
        },
        {
            "chunk_id": "slide-1",
            "source_file": "course_slides/lecture8.txt",
            "source_type": "course_slide",
            "citation_role": "class_context",
            "title": "Lecture 8",
            "text": "部分トレースは複合系の一部を消去し、部分系の状態を得る操作である。",
        },
    ]

    bindings = build_paragraph_sources(paragraph, sources)

    assert bindings[0]["grounding_status"] == "grounded_candidate"
    assert bindings[0]["source_refs"][0]["chunk_id"] == "slide-1"
    assert all(ref["source_type"] != "report_template" for ref in bindings[0]["source_refs"])


def test_run_manifest_records_reproducible_generation_context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JSTYLE_RAG_ROOT", str(tmp_path))
    monkeypatch.setenv("JSTYLE_LLM_PROVIDER", "offline")
    monkeypatch.setenv("JSTYLE_EMBEDDING_MODEL", "hash")
    cfg = get_config()
    ensure_directories(cfg)
    source = {
        "chunk_id": "slide-1",
        "source_file": "course_slides/lecture8.txt",
        "source_type": "course_slide",
        "citation_role": "class_context",
        "text": "部分トレースは複合系の一部を消去する。",
        "score": 0.9,
    }
    paragraph_sources = build_paragraph_sources("部分トレースは複合系の一部を消去する。", [source])

    manifest = build_run_manifest(
        config=cfg,
        topic="部分トレース",
        word_count=1200,
        discipline="quantum_information",
        target_style="undergraduate_report",
        requirements="講義資料に基づく",
        user_points=["定義を明確にする"],
        top_k_style=3,
        top_k_sources=6,
        top_k_templates=2,
        prompt="prompt",
        raw_response="raw",
        draft="部分トレースは複合系の一部を消去する。",
        style_profiles=[],
        template_chunks=[],
        source_chunks=[source],
        paragraph_sources=paragraph_sources,
        citation_warnings=[],
        similarity_warnings=[],
    )

    assert manifest["run_id"]
    assert manifest["generation"]["provider"] == "offline"
    assert manifest["inputs"]["topic"] == "部分トレース"
    assert manifest["retrieval"]["sources"][0]["chunk_id"] == "slide-1"
    assert manifest["artifacts"]["draft_sha256"]
    assert manifest["guard_summary"]["paragraph_count"] == 1


def test_source_index_rejects_stale_processed_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JSTYLE_RAG_ROOT", str(tmp_path))
    monkeypatch.setenv("JSTYLE_EMBEDDING_MODEL", "hash")
    cfg = get_config()
    ensure_directories(cfg)
    source = cfg.source_raw_dir / "course_slides" / "lecture8.txt"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("部分トレースは複合系の一部を消去する操作である。", encoding="utf-8")
    ingest_sources(cfg)
    build_source_index(cfg)

    chunks_path = cfg.source_processed_dir / "source_chunks.jsonl"
    rows = [json.loads(line) for line in chunks_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows[0]["text"] = "未再構築の別内容"
    chunks_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="stale"):
        retrieve_source_chunks("部分トレース", config=cfg)
