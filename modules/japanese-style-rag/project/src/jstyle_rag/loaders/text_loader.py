from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".text"}


@dataclass(frozen=True)
class LoadedChunk:
    chunk_id: str
    source_file: str
    text: str
    page: int | None = None
    section: str | None = None


def load_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def iter_supported_files(root: Path, suffixes: set[str] | None = None) -> Iterable[Path]:
    allowed = suffixes or TEXT_SUFFIXES | {".pdf"}
    if not root.exists():
        return
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in allowed:
            yield path


def chunk_text(
    text: str,
    source_file: str,
    chunk_size: int = 900,
    overlap: int = 120,
    page: int | None = None,
    section: str | None = None,
) -> list[LoadedChunk]:
    normalized = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not normalized:
        return []

    chunks: list[LoadedChunk] = []
    start = 0
    ordinal = 1
    while start < len(normalized):
        end = min(len(normalized), start + chunk_size)
        if end < len(normalized):
            boundary = max(
                normalized.rfind("。", start, end),
                normalized.rfind("\n\n", start, end),
                normalized.rfind("\n", start, end),
            )
            if boundary > start + chunk_size // 2:
                end = boundary + 1
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(
                LoadedChunk(
                    chunk_id=f"{Path(source_file).stem}-{page or 0}-{ordinal}",
                    source_file=source_file,
                    text=chunk,
                    page=page,
                    section=section,
                )
            )
            ordinal += 1
        if end >= len(normalized):
            break
        start = max(0, end - overlap)
    return chunks
