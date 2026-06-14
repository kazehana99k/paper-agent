from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from jstyle_rag.config import AppConfig, get_config
from jstyle_rag.loaders.pdf_loader import load_pdf_chunks
from jstyle_rag.loaders.text_loader import TEXT_SUFFIXES, chunk_text, iter_supported_files, load_text_file

from .source_metadata import infer_source_metadata, load_sidecar_metadata, merge_source_metadata


SOURCE_CHUNKS_JSONL = "source_chunks.jsonl"


def default_source_chunks_path(config: AppConfig | None = None) -> Path:
    cfg = config or get_config()
    return cfg.source_processed_dir / SOURCE_CHUNKS_JSONL


def ingest_sources(config: AppConfig | None = None) -> list[dict[str, Any]]:
    cfg = config or get_config()
    records: list[dict[str, Any]] = []
    for path in iter_supported_files(cfg.source_raw_dir):
        relative = str(path.relative_to(cfg.source_raw_dir))
        if path.suffix.lower() in TEXT_SUFFIXES:
            text = load_text_file(path)
            chunks = chunk_text(text, source_file=relative, chunk_size=900, overlap=120)
        elif path.suffix.lower() == ".pdf":
            chunks = load_pdf_chunks(path, relative_name=relative)
            text = "\n".join(chunk.text for chunk in chunks[:2])
        else:
            continue
        source_metadata = merge_source_metadata(
            infer_source_metadata(relative, text),
            load_sidecar_metadata(path),
        )
        raw_file_sha256 = _file_sha256(path)
        for chunk in chunks:
            records.append(
                {
                    "chunk_id": chunk.chunk_id,
                    "source_file": chunk.source_file,
                    "raw_file_sha256": raw_file_sha256,
                    "page": chunk.page,
                    "section": chunk.section,
                    **source_metadata,
                    "text": chunk.text,
                }
            )

    output_path = default_source_chunks_path(cfg)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return records


def load_source_chunks(config: AppConfig | None = None) -> list[dict[str, Any]]:
    path = default_source_chunks_path(config)
    if not path.exists():
        return []
    chunks: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                chunks.append(json.loads(line))
    return chunks


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
