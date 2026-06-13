from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jstyle_rag.config import AppConfig, get_config
from jstyle_rag.loaders.pdf_loader import load_pdf_chunks
from jstyle_rag.loaders.text_loader import TEXT_SUFFIXES, chunk_text, iter_supported_files, load_text_file
from jstyle_rag.vector import VectorSearchResult, make_embedding_model, make_vector_index

from .style_extractor import load_style_profiles
from .style_profile_schema import StyleProfile


STYLE_PROFILE_JSONL = "style_profiles.jsonl"
STYLE_PROFILE_INDEX_JSONL = "style_profile_vectors.jsonl"
STYLE_RAW_CHUNK_INDEX_JSONL = "style_raw_chunk_vectors.jsonl"


def default_profiles_path(config: AppConfig | None = None) -> Path:
    cfg = config or get_config()
    return cfg.style_profiles_dir / STYLE_PROFILE_JSONL


def profile_to_index_text(profile: StyleProfile) -> str:
    return "\n".join(
        [
            f"doc_type: {profile.doc_type}",
            f"discipline: {profile.discipline}",
            f"paragraph_length_pattern: {profile.paragraph_length_pattern}",
            f"sentence_ending_pattern: {', '.join(profile.sentence_ending_pattern)}",
            f"connective_pattern: {', '.join(profile.connective_pattern)}",
            f"structure_pattern: {', '.join(profile.structure_pattern)}",
            f"tone: {profile.tone}",
            f"anti_ai_notes: {', '.join(profile.anti_ai_notes)}",
            f"style_summary_ja: {profile.style_summary_ja}",
        ]
    )


def build_style_profile_index(config: AppConfig | None = None) -> int:
    cfg = config or get_config()
    profiles = load_style_profiles(default_profiles_path(cfg))
    records = [
        {
            "id": profile.style_id,
            "text": profile_to_index_text(profile),
            "metadata": profile.to_dict(),
        }
        for profile in profiles
    ]
    embedding_model = make_embedding_model(cfg.embedding_model, cfg.allow_hash_embeddings)
    index = make_vector_index(
        cfg.vector_backend,
        cfg.style_index_dir / STYLE_PROFILE_INDEX_JSONL,
        cfg.style_index_dir / "chroma",
        "style_profiles",
        embedding_model,
    )
    return index.build(records)


def iter_style_raw_chunk_records(config: AppConfig | None = None) -> list[dict[str, Any]]:
    cfg = config or get_config()
    records: list[dict[str, Any]] = []
    for path in iter_supported_files(cfg.style_raw_dir):
        relative = str(path.relative_to(cfg.style_raw_dir))
        if path.suffix.lower() in TEXT_SUFFIXES:
            chunks = chunk_text(load_text_file(path), source_file=relative, chunk_size=700, overlap=80)
        elif path.suffix.lower() == ".pdf":
            chunks = load_pdf_chunks(path, relative_name=relative)
        else:
            continue
        for chunk in chunks:
            records.append(
                {
                    "id": f"style-raw-{chunk.chunk_id}",
                    "text": chunk.text,
                    "metadata": {
                        "source_file": chunk.source_file,
                        "page": chunk.page or "",
                        "chunk_id": chunk.chunk_id,
                        "usage": "similarity_guard_only",
                    },
                }
            )
    return records


def build_style_raw_chunk_index(config: AppConfig | None = None) -> int:
    cfg = config or get_config()
    records = iter_style_raw_chunk_records(cfg)
    embedding_model = make_embedding_model(cfg.embedding_model, cfg.allow_hash_embeddings)
    index = make_vector_index(
        cfg.vector_backend,
        cfg.style_index_dir / STYLE_RAW_CHUNK_INDEX_JSONL,
        cfg.style_index_dir / "chroma",
        "style_raw_chunks",
        embedding_model,
    )
    return index.build(records)


def build_style_indexes(config: AppConfig | None = None) -> dict[str, int]:
    cfg = config or get_config()
    return {
        "style_profiles": build_style_profile_index(cfg),
        "style_raw_chunks": build_style_raw_chunk_index(cfg),
    }


def retrieve_style_profiles(
    topic: str,
    discipline: str | None = None,
    target_style: str | None = None,
    top_k: int = 3,
    config: AppConfig | None = None,
) -> list[dict[str, Any]]:
    cfg = config or get_config()
    embedding_model = make_embedding_model(cfg.embedding_model, cfg.allow_hash_embeddings)
    index = make_vector_index(
        cfg.vector_backend,
        cfg.style_index_dir / STYLE_PROFILE_INDEX_JSONL,
        cfg.style_index_dir / "chroma",
        "style_profiles",
        embedding_model,
    )
    query = f"{topic}\ndiscipline: {discipline or ''}\ntarget_style: {target_style or ''}"
    filters: dict[str, Any] = {}
    if discipline:
        filters["discipline"] = discipline
    if target_style:
        filters["doc_type"] = target_style

    results = index.search(query, top_k=top_k, where=filters)
    if not results and filters:
        results = index.search(query, top_k=top_k)
    return [_sanitize_style_result(result) for result in results]


def load_style_raw_chunks(config: AppConfig | None = None) -> list[dict[str, Any]]:
    cfg = config or get_config()
    path = cfg.style_index_dir / STYLE_RAW_CHUNK_INDEX_JSONL
    if path.exists():
        chunks: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                record = json.loads(line)
                chunks.append(
                    {
                        "text": record["text"],
                        "metadata": record.get("metadata", {}),
                    }
                )
        return chunks
    return [
        {"text": record["text"], "metadata": record.get("metadata", {})}
        for record in iter_style_raw_chunk_records(cfg)
    ]


def _sanitize_style_result(result: VectorSearchResult) -> dict[str, Any]:
    metadata = result.metadata.copy()
    metadata.pop("do_not_copy_examples", None)
    return {
        "style_id": result.record_id,
        "score": result.score,
        "doc_type": metadata.get("doc_type", "unknown"),
        "discipline": metadata.get("discipline", "unknown"),
        "paragraph_length_pattern": metadata.get("paragraph_length_pattern", ""),
        "sentence_ending_pattern": metadata.get("sentence_ending_pattern", []),
        "connective_pattern": metadata.get("connective_pattern", []),
        "structure_pattern": metadata.get("structure_pattern", []),
        "tone": metadata.get("tone", "natural_academic"),
        "anti_ai_notes": metadata.get("anti_ai_notes", []),
        "style_summary_ja": metadata.get("style_summary_ja", ""),
        "source_file": metadata.get("source_file", ""),
    }
