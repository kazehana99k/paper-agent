from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .text_loader import LoadedChunk, chunk_text


def load_pdf_pages(path: Path) -> list[tuple[int, str]]:
    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        try:
            result = subprocess.run(
                [pdftotext, "-layout", str(path), "-"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=60,
            )
            pages = result.stdout.split("\f")
            return [(index, page.strip()) for index, page in enumerate(pages, start=1) if page.strip()]
        except Exception:
            pass

    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:
        raise RuntimeError("pypdf is required to read PDF files") from exc

    reader = PdfReader(str(path))
    pages: list[tuple[int, str]] = []
    for index, page in enumerate(reader.pages, start=1):
        pages.append((index, page.extract_text() or ""))
    return pages


def load_pdf_chunks(path: Path, relative_name: str | None = None) -> list[LoadedChunk]:
    source_file = relative_name or path.name
    chunks: list[LoadedChunk] = []
    for page_number, text in load_pdf_pages(path):
        chunks.extend(chunk_text(text, source_file=source_file, page=page_number))
    return chunks
