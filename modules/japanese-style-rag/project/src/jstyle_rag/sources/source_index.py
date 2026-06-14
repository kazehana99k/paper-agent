from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from jstyle_rag.config import AppConfig, get_config
from jstyle_rag.vector import VectorSearchResult, make_embedding_model, make_vector_index

from .source_ingest import load_source_chunks


SOURCE_INDEX_JSONL = "source_vectors.jsonl"
SOURCE_INDEX_MANIFEST = "source_vectors.manifest.json"


def build_source_index(config: AppConfig | None = None) -> int:
    cfg = config or get_config()
    chunks = load_source_chunks(cfg)
    records = [
        {
            "id": chunk["chunk_id"],
            "text": chunk["text"],
            "metadata": {
                "chunk_id": chunk["chunk_id"],
                "source_file": chunk["source_file"],
                "raw_file_sha256": chunk.get("raw_file_sha256", ""),
                "page": chunk.get("page") or "",
                "section": chunk.get("section") or "",
                "source_type": chunk.get("source_type", "unknown"),
                "authority_level": chunk.get("authority_level", "unknown"),
                "citation_role": chunk.get("citation_role", "unknown"),
                "title": chunk.get("title", ""),
                "source_url": chunk.get("source_url", ""),
                "landing_url": chunk.get("landing_url", ""),
                "published_date": chunk.get("published_date", ""),
                "publisher": chunk.get("publisher", ""),
                "license_note": chunk.get("license_note", ""),
            },
        }
        for chunk in chunks
    ]
    embedding_model = make_embedding_model(cfg.embedding_model, cfg.allow_hash_embeddings)
    index = make_vector_index(
        cfg.vector_backend,
        cfg.source_index_dir / SOURCE_INDEX_JSONL,
        cfg.source_index_dir / "chroma",
        "source_chunks",
        embedding_model,
    )
    count = index.build(records)
    _write_index_manifest(cfg, chunks, count)
    return count


def retrieve_source_chunks(
    topic: str,
    top_k: int = 6,
    source_type: str | None = None,
    citation_role: str | None = None,
    config: AppConfig | None = None,
) -> list[dict[str, Any]]:
    cfg = config or get_config()
    _assert_index_manifest_compatible(cfg)
    embedding_model = make_embedding_model(cfg.embedding_model, cfg.allow_hash_embeddings)
    index = make_vector_index(
        cfg.vector_backend,
        cfg.source_index_dir / SOURCE_INDEX_JSONL,
        cfg.source_index_dir / "chroma",
        "source_chunks",
        embedding_model,
    )
    where: dict[str, Any] = {}
    if source_type:
        where["source_type"] = source_type
    if citation_role:
        where["citation_role"] = citation_role
    results = index.search(topic, top_k=top_k, where=where)
    if not results and where:
        results = index.search(topic, top_k=top_k)
    return [_source_result_to_dict(result) for result in results]


def source_index_manifest(config: AppConfig | None = None) -> dict[str, Any] | None:
    cfg = config or get_config()
    path = cfg.source_index_dir / SOURCE_INDEX_MANIFEST
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_index_manifest(cfg: AppConfig, chunks: list[dict[str, Any]], count: int) -> None:
    manifest = {
        "vector_backend": cfg.vector_backend,
        "embedding_model": cfg.embedding_model,
        "embedding_base_url": cfg.embedding_base_url,
        "allow_hash_embeddings": cfg.allow_hash_embeddings,
        "record_count": count,
        "chunks_sha256": _chunks_fingerprint(chunks),
        "built_at": datetime.now().isoformat(timespec="seconds"),
    }
    cfg.source_index_dir.mkdir(parents=True, exist_ok=True)
    (cfg.source_index_dir / SOURCE_INDEX_MANIFEST).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _assert_index_manifest_compatible(cfg: AppConfig) -> None:
    manifest = source_index_manifest(cfg)
    if not manifest:
        return
    expected = {
        "vector_backend": cfg.vector_backend,
        "embedding_model": cfg.embedding_model,
        "embedding_base_url": cfg.embedding_base_url,
        "allow_hash_embeddings": cfg.allow_hash_embeddings,
    }
    mismatches = [
        f"{key}: index={manifest.get(key)!r}, current={value!r}"
        for key, value in expected.items()
        if manifest.get(key) != value
    ]
    current_chunks_sha256 = _chunks_fingerprint(load_source_chunks(cfg))
    if manifest.get("chunks_sha256") != current_chunks_sha256:
        mismatches.append(
            f"chunks_sha256: index={manifest.get('chunks_sha256')!r}, current={current_chunks_sha256!r}"
        )
    if mismatches:
        raise RuntimeError("source index embedding settings are stale; rebuild index. " + "; ".join(mismatches))


def _chunks_fingerprint(chunks: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(str(chunk.get("chunk_id", "")).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(chunk.get("text", "")).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _source_result_to_dict(result: VectorSearchResult) -> dict[str, Any]:
    metadata = result.metadata
    return {
        "chunk_id": metadata.get("chunk_id", result.record_id),
        "source_file": metadata.get("source_file", ""),
        "raw_file_sha256": metadata.get("raw_file_sha256", ""),
        "page": metadata.get("page", ""),
        "section": metadata.get("section", ""),
        "source_type": metadata.get("source_type", "unknown"),
        "authority_level": metadata.get("authority_level", "unknown"),
        "citation_role": metadata.get("citation_role", "unknown"),
        "title": metadata.get("title", ""),
        "source_url": metadata.get("source_url", ""),
        "landing_url": metadata.get("landing_url", ""),
        "published_date": metadata.get("published_date", ""),
        "publisher": metadata.get("publisher", ""),
        "license_note": metadata.get("license_note", ""),
        "text": result.text,
        "score": result.score,
    }
