from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from jstyle_rag.loaders.text_loader import chunk_text, iter_supported_files, load_text_file
from jstyle_rag.vector import EmbeddingModel, cosine_similarity, make_embedding_model


@dataclass(frozen=True)
class SimilarityWarning:
    generated_excerpt: str
    style_source_file: str
    style_chunk_id: str
    embedding_similarity: float
    ngram_overlap: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def check_similarity(
    generated_text: str,
    style_chunks: Iterable[str | dict[str, Any]] | None = None,
    style_raw_dir: Path | None = None,
    embedding_threshold: float = 0.92,
    ngram_threshold: float = 0.58,
    embedding_model: EmbeddingModel | None = None,
) -> list[SimilarityWarning]:
    if not generated_text.strip():
        return []
    chunks = _normalize_style_chunks(style_chunks, style_raw_dir)
    if not chunks:
        return []

    model = embedding_model or make_embedding_model()
    generated_units = _candidate_units(generated_text)
    warnings: list[SimilarityWarning] = []
    for generated_unit in generated_units:
        if len(generated_unit) < 25:
            continue
        generated_embedding = model.encode(generated_unit)
        for style_chunk in chunks:
            style_text = style_chunk["text"]
            if len(style_text) < 25:
                continue
            ngram = ngram_overlap(generated_unit, style_text)
            embedding = cosine_similarity(generated_embedding, model.encode(style_text))
            if ngram >= ngram_threshold or embedding >= embedding_threshold:
                warnings.append(
                    SimilarityWarning(
                        generated_excerpt=_shorten(generated_unit),
                        style_source_file=str(style_chunk.get("source_file", "")),
                        style_chunk_id=str(style_chunk.get("chunk_id", "")),
                        embedding_similarity=round(float(embedding), 4),
                        ngram_overlap=round(float(ngram), 4),
                        reason="style corpusとの類似度が高いため、表現を抽象化して書き直す必要がある",
                    )
                )
                break
    return warnings


def ngram_overlap(a: str, b: str, n: int = 5) -> float:
    grams_a = _char_ngrams(a, n)
    grams_b = _char_ngrams(b, n)
    if not grams_a or not grams_b:
        return 0.0
    return len(grams_a & grams_b) / len(grams_a)


def _char_ngrams(text: str, n: int) -> set[str]:
    normalized = re.sub(r"\s+", "", text)
    return {normalized[index : index + n] for index in range(max(0, len(normalized) - n + 1))}


def _candidate_units(text: str) -> list[str]:
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", text) if item.strip()]
    if paragraphs:
        return paragraphs
    return [item.strip() for item in re.split(r"(?<=[。！？])", text) if item.strip()]


def _normalize_style_chunks(
    style_chunks: Iterable[str | dict[str, Any]] | None,
    style_raw_dir: Path | None,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if style_chunks is not None:
        for index, chunk in enumerate(style_chunks):
            if isinstance(chunk, str):
                normalized.append({"text": chunk, "source_file": "provided", "chunk_id": str(index)})
            else:
                metadata = chunk.get("metadata", {})
                normalized.append(
                    {
                        "text": chunk.get("text", ""),
                        "source_file": metadata.get("source_file", chunk.get("source_file", "provided")),
                        "chunk_id": metadata.get("chunk_id", chunk.get("chunk_id", str(index))),
                    }
                )
    elif style_raw_dir is not None:
        for path in iter_supported_files(style_raw_dir, suffixes={".txt", ".md", ".markdown", ".text"}):
            relative = str(path.relative_to(style_raw_dir))
            for chunk in chunk_text(load_text_file(path), source_file=relative, chunk_size=700, overlap=80):
                normalized.append(
                    {
                        "text": chunk.text,
                        "source_file": chunk.source_file,
                        "chunk_id": chunk.chunk_id,
                    }
                )
    return [item for item in normalized if item.get("text")]


def _shorten(text: str, limit: int = 160) -> str:
    one_line = re.sub(r"\s+", " ", text).strip()
    if len(one_line) <= limit:
        return one_line
    return one_line[: limit - 1] + "..."
