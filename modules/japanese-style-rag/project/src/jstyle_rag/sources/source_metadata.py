from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from jstyle_rag.loaders.text_loader import TEXT_SUFFIXES, iter_supported_files


SourceType = Literal[
    "academic_paper",
    "government_report",
    "industry_report",
    "technical_report",
    "white_paper",
    "lecture_note",
    "course_slide",
    "course_handout",
    "book",
    "report_template",
    "user_note",
    "unknown",
]
AuthorityLevel = Literal[
    "peer_reviewed",
    "preprint",
    "official",
    "institutional",
    "class_material",
    "textbook",
    "user_provided",
    "unknown",
]
CitationRole = Literal[
    "prior_research",
    "factual_background",
    "statistics",
    "technical_overview",
    "class_context",
    "assignment_requirements",
    "theory_framework",
    "template_structure",
    "unknown",
]

VALID_SOURCE_TYPES = {
    "academic_paper",
    "government_report",
    "industry_report",
    "technical_report",
    "white_paper",
    "lecture_note",
    "course_slide",
    "course_handout",
    "book",
    "report_template",
    "user_note",
    "unknown",
}
VALID_AUTHORITY_LEVELS = {
    "peer_reviewed",
    "preprint",
    "official",
    "institutional",
    "class_material",
    "textbook",
    "user_provided",
    "unknown",
}
VALID_CITATION_ROLES = {
    "prior_research",
    "factual_background",
    "statistics",
    "technical_overview",
    "class_context",
    "assignment_requirements",
    "theory_framework",
    "template_structure",
    "unknown",
}


@dataclass(frozen=True)
class SourceMetadata:
    source_type: SourceType = "unknown"
    authority_level: AuthorityLevel = "unknown"
    citation_role: CitationRole = "unknown"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def infer_source_metadata(relative_path: str, text_sample: str = "") -> SourceMetadata:
    """Infer coarse source metadata from local paths and a short text sample.

    Users can override the inference by placing files in clear folders such as
    `papers/`, `reports/`, `lecture_notes/`, or `user_notes/`.
    """
    target = _normalize(f"{relative_path}\n{text_sample[:1200]}")

    if _has(target, "template", "rubric", "format", "課題要項", "評価基準", "レポート様式", "テンプレート"):
        return SourceMetadata("report_template", "class_material", "template_structure")
    if _has(target, "handout", "assignment", "課題", "配布資料", "講義配布"):
        return SourceMetadata("course_handout", "class_material", "assignment_requirements")
    if _has(target, "slides", "slide", "スライド", "ppt", "講義資料"):
        return SourceMetadata("course_slide", "class_material", "class_context")
    if _has(target, "lecture", "class", "授業", "講義", "講義ノート"):
        return SourceMetadata("lecture_note", "class_material", "class_context")
    if _has(target, "book", "textbook", "chapter", "教科書", "書籍", "章"):
        return SourceMetadata("book", "textbook", "theory_framework")
    if _has(target, "user_note", "user-notes", "notes", "memo", "メモ", "ノート", "考察メモ"):
        return SourceMetadata("user_note", "user_provided", "class_context")
    if _has(target, "arxiv"):
        return SourceMetadata("academic_paper", "preprint", "prior_research")
    if _has(target, "paper", "papers", "論文", "journal", "conference", "proceedings", "j-stage", "jstage", "arxiv"):
        return SourceMetadata("academic_paper", "peer_reviewed", "prior_research")
    if _has(target, "whitepaper", "white-paper", "white_paper", "ホワイトペーパー", "白書"):
        return SourceMetadata("white_paper", "official", "technical_overview")
    if _has(target, "soumu", "総務省", "nisc", "政府", "内閣", "白書", "統計"):
        return SourceMetadata("government_report", "official", "statistics")
    if _has(target, "ipa", "jpcert", "nict", "情報処理推進機構", "情報通信研究機構", "報告書", "調査報告"):
        return SourceMetadata("technical_report", "institutional", "factual_background")
    if _has(target, "industry", "vendor", "company", "企業", "市場調査", "annual-report"):
        return SourceMetadata("industry_report", "institutional", "factual_background")
    if _has(target, "technical-report", "tech-report", "技術報告", "research-report", "研究報告"):
        return SourceMetadata("technical_report", "institutional", "technical_overview")
    return SourceMetadata()


def load_sidecar_metadata(path: Path) -> dict[str, str]:
    """Load optional `filename.ext.meta.json` metadata overrides."""
    sidecar = path.with_name(f"{path.name}.meta.json")
    if not sidecar.exists():
        return {}
    data = json.loads(sidecar.read_text(encoding="utf-8"))
    allowed = {
        "source_type",
        "authority_level",
        "citation_role",
        "title",
        "source_url",
        "landing_url",
        "published_date",
        "publisher",
        "license_note",
        "module_material_type",
        "module_material_label",
    }
    return {
        key: str(value)
        for key, value in data.items()
        if key in allowed and value is not None
    }


def merge_source_metadata(inferred: SourceMetadata, overrides: dict[str, str]) -> dict[str, str]:
    data = inferred.to_dict()
    for key in (
        "source_type",
        "authority_level",
        "citation_role",
        "title",
        "source_url",
        "landing_url",
        "published_date",
        "publisher",
        "license_note",
        "module_material_type",
        "module_material_label",
    ):
        if overrides.get(key):
            data[key] = overrides[key]
    return data


def classify_source_files(raw_dir: Path) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for path in iter_supported_files(raw_dir):
        relative = str(path.relative_to(raw_dir))
        sample = _text_sample(path)
        inferred = infer_source_metadata(relative, sample)
        overrides = load_sidecar_metadata(path)
        metadata = merge_source_metadata(inferred, overrides)
        results.append(
            {
                "source_file": relative,
                "sidecar": str(path.with_name(f"{path.name}.meta.json").relative_to(raw_dir)),
                "has_sidecar": str(bool(overrides)).lower(),
                **metadata,
            }
        )
    return results


def write_sidecar_metadata(
    source_file: Path,
    source_type: str,
    authority_level: str,
    citation_role: str,
) -> Path:
    _validate_choice("source_type", source_type, VALID_SOURCE_TYPES)
    _validate_choice("authority_level", authority_level, VALID_AUTHORITY_LEVELS)
    _validate_choice("citation_role", citation_role, VALID_CITATION_ROLES)
    sidecar = source_file.with_name(f"{source_file.name}.meta.json")
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "source_type": source_type,
        "authority_level": authority_level,
        "citation_role": citation_role,
    }
    sidecar.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return sidecar


def resolve_source_path(raw_dir: Path, source_file: Path) -> Path:
    if source_file.is_absolute():
        return source_file
    return raw_dir / source_file


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def _has(text: str, *needles: str) -> bool:
    return any(needle.lower() in text for needle in needles)


def _text_sample(path: Path, limit: int = 1200) -> str:
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return ""
    try:
        return path.read_text(encoding="utf-8")[:limit]
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")[:limit]


def _validate_choice(name: str, value: str, valid_values: set[str]) -> None:
    if value not in valid_values:
        allowed = ", ".join(sorted(valid_values))
        raise ValueError(f"Invalid {name}: {value}. Expected one of: {allowed}")
