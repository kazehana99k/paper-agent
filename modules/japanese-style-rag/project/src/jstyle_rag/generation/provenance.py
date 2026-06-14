from __future__ import annotations

import hashlib
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jstyle_rag.config import AppConfig
from jstyle_rag.sources.citation_guard import SOURCE_MARKER
from jstyle_rag.sources.source_ingest import default_source_chunks_path
from jstyle_rag.sources.source_index import source_index_manifest
from jstyle_rag.style.style_index import (
    STYLE_PROFILE_INDEX_JSONL,
    STYLE_RAW_CHUNK_INDEX_JSONL,
    default_profiles_path,
)


FACTUAL_TRIGGER_RE = re.compile(
    r"(?:19|20)\d{2}年?|"
    r"\d+(?:\.\d+)?\s*(?:%|％|人|名|件|円|ドル|倍|割|ポイント|年|回|社)|"
    r"によれば|によると|に基づくと|は述べている|は指摘している|"
    r"定義|定理|証明|研究|報告|調査|統計|資料|講義|スライド"
)


def build_paragraph_sources(
    draft: str,
    source_chunks: list[dict[str, Any]],
    max_sources_per_paragraph: int = 3,
) -> list[dict[str, Any]]:
    factual_chunks = [
        chunk
        for chunk in source_chunks
        if chunk.get("source_type") != "report_template"
        and chunk.get("citation_role") != "template_structure"
    ]
    bindings: list[dict[str, Any]] = []
    for index, paragraph in enumerate(_split_paragraphs(draft), start=1):
        ranked = _rank_source_chunks(paragraph, factual_chunks)
        refs = ranked[:max_sources_per_paragraph]
        has_marker = SOURCE_MARKER in paragraph
        has_factual_trigger = bool(FACTUAL_TRIGGER_RE.search(paragraph))
        if has_marker:
            status = "needs_source"
        elif refs:
            status = "grounded_candidate"
        elif has_factual_trigger:
            status = "needs_source"
        else:
            status = "no_source_needed"
        bindings.append(
            {
                "paragraph_index": index,
                "paragraph_hash": sha256_text(paragraph),
                "text_preview": _preview(paragraph),
                "grounding_status": status,
                "has_source_marker": has_marker,
                "has_factual_trigger": has_factual_trigger,
                "source_refs": refs,
            }
        )
    return bindings


def build_run_manifest(
    *,
    config: AppConfig,
    topic: str,
    word_count: int,
    discipline: str,
    target_style: str,
    requirements: str,
    user_points: list[str],
    top_k_style: int,
    top_k_sources: int,
    top_k_templates: int,
    prompt: str,
    raw_response: str,
    draft: str,
    style_profiles: list[dict[str, Any]],
    template_chunks: list[dict[str, Any]],
    source_chunks: list[dict[str, Any]],
    paragraph_sources: list[dict[str, Any]],
    citation_warnings: list[dict[str, Any]],
    similarity_warnings: list[dict[str, Any]],
) -> dict[str, Any]:
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "schema_version": 1,
        "generated_at": generated_at,
        "inputs": {
            "topic": topic,
            "word_count": word_count,
            "discipline": discipline,
            "target_style": target_style,
            "requirements_sha256": sha256_text(requirements),
            "user_points_sha256": sha256_json(user_points),
            "top_k_style": top_k_style,
            "top_k_sources": top_k_sources,
            "top_k_templates": top_k_templates,
        },
        "generation": generation_settings(config),
        "indexes": index_snapshot(config),
        "retrieval": {
            "style_profiles": [_style_ref(item) for item in style_profiles],
            "templates": [_source_ref(item) for item in template_chunks],
            "sources": [_source_ref(item) for item in source_chunks],
        },
        "artifacts": {
            "prompt_sha256": sha256_text(prompt),
            "raw_response_sha256": sha256_text(raw_response),
            "draft_sha256": sha256_text(draft),
            "paragraph_sources_sha256": sha256_json(paragraph_sources),
        },
        "guard_summary": {
            "citation_warning_count": len(citation_warnings),
            "similarity_warning_count": len(similarity_warnings),
            "paragraph_count": len(paragraph_sources),
            "needs_source_count": sum(
                1 for item in paragraph_sources if item.get("grounding_status") == "needs_source"
            ),
        },
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
    }
    manifest["run_id"] = sha256_json(
        {
            "inputs": manifest["inputs"],
            "generation": manifest["generation"],
            "indexes": manifest["indexes"],
            "retrieval": manifest["retrieval"],
            "artifacts": manifest["artifacts"],
            "guard_summary": manifest["guard_summary"],
        }
    )[:16]
    return manifest


def generation_settings(config: AppConfig) -> dict[str, Any]:
    provider = config.llm_provider
    if provider == "ollama":
        return {
            "provider": provider,
            "model": config.ollama_model,
            "base_url": config.ollama_base_url,
            "parameters": {},
        }
    if provider in {"openai", "openai-compatible", "openai_compatible"}:
        return {
            "provider": provider,
            "model": config.openai_model,
            "base_url": config.openai_base_url,
            "parameters": {"temperature": 0.4},
        }
    return {
        "provider": "offline",
        "model": "offline_fallback",
        "base_url": "",
        "parameters": {"deterministic": True},
    }


def index_snapshot(config: AppConfig) -> dict[str, Any]:
    return {
        "vector_backend": config.vector_backend,
        "embedding_model": config.embedding_model,
        "embedding_base_url": config.embedding_base_url,
        "allow_hash_embeddings": config.allow_hash_embeddings,
        "source_index_manifest": source_index_manifest(config),
        "source_chunks_file": _file_snapshot(default_source_chunks_path(config), config.project_root),
        "style_profiles_file": _file_snapshot(default_profiles_path(config), config.project_root),
        "style_profile_index_file": _file_snapshot(
            config.style_index_dir / STYLE_PROFILE_INDEX_JSONL,
            config.project_root,
        ),
        "style_raw_chunk_index_file": _file_snapshot(
            config.style_index_dir / STYLE_RAW_CHUNK_INDEX_JSONL,
            config.project_root,
        ),
    }


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _split_paragraphs(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"\n\s*\n", text) if item.strip()]


def _rank_source_chunks(paragraph: str, source_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    paragraph_terms = _content_terms(paragraph)
    paragraph_term_set = set(paragraph_terms)
    ranked: list[dict[str, Any]] = []
    if not paragraph_term_set:
        return ranked
    for chunk in source_chunks:
        source_text = " ".join(
            str(chunk.get(key, ""))
            for key in ("title", "publisher", "published_date", "text")
        )
        source_terms = set(_content_terms(source_text))
        matched_terms = sorted(paragraph_term_set & source_terms)
        if not matched_terms:
            continue
        score = len(matched_terms) / max(1.0, len(paragraph_term_set) ** 0.5 * len(source_terms) ** 0.5)
        ranked.append(
            {
                **_source_ref(chunk),
                "match_score": round(score, 4),
                "matched_terms": matched_terms[:12],
            }
        )
    ranked.sort(key=lambda item: (-float(item.get("match_score", 0)), str(item.get("chunk_id", ""))))
    return ranked


def _source_ref(chunk: dict[str, Any]) -> dict[str, Any]:
    text = str(chunk.get("text", ""))
    return {
        "chunk_id": chunk.get("chunk_id", ""),
        "source_file": chunk.get("source_file", ""),
        "raw_file_sha256": chunk.get("raw_file_sha256", ""),
        "page": chunk.get("page", ""),
        "section": chunk.get("section", ""),
        "source_type": chunk.get("source_type", "unknown"),
        "authority_level": chunk.get("authority_level", "unknown"),
        "citation_role": chunk.get("citation_role", "unknown"),
        "title": chunk.get("title", ""),
        "source_url": chunk.get("source_url", ""),
        "published_date": chunk.get("published_date", ""),
        "publisher": chunk.get("publisher", ""),
        "score": chunk.get("score"),
        "text_sha256": sha256_text(text),
    }


def _style_ref(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "style_id": profile.get("style_id", ""),
        "score": profile.get("score"),
        "doc_type": profile.get("doc_type", "unknown"),
        "discipline": profile.get("discipline", "unknown"),
        "tone": profile.get("tone", ""),
        "source_file": profile.get("source_file", ""),
        "profile_sha256": sha256_json(profile),
    }


def _file_snapshot(path: Path, root: Path) -> dict[str, Any] | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        rel = str(path.relative_to(root))
    except ValueError:
        rel = str(path)
    return {
        "path": rel,
        "size": path.stat().st_size,
        "sha256": _file_sha256(path),
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _content_terms(text: str) -> list[str]:
    terms = re.findall(r"[一-龯々ァ-ヴーA-Za-z0-9][一-龯々ァ-ヴーA-Za-z0-9・/_-]{1,}", text)
    stop = {
        "これ",
        "ため",
        "こと",
        "もの",
        "よう",
        "する",
        "ある",
        "いる",
        "れる",
        "及び",
        "また",
        "そして",
        "the",
        "and",
        "for",
        "with",
    }
    return [term for term in terms if term.lower() not in stop]


def _preview(text: str, limit: int = 220) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "..."
