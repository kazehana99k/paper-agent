from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Iterable


SOURCE_MARKER = "[要出典確認]"


@dataclass(frozen=True)
class CitationWarning:
    sentence: str
    trigger: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CitationCheckResult:
    text: str
    warnings: list[CitationWarning]

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "warnings": [warning.to_dict() for warning in self.warnings]}


YEAR_RE = re.compile(r"(?<!\d)(?:19|20)\d{2}年?")
STAT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:%|％|人|名|件|円|ドル|倍|割|ポイント|年|回|社)")
ACCORDING_RE = re.compile(r"(によれば|によると|に基づくと|は述べている|は指摘している)")
TITLE_RE = re.compile(r"『[^』]{3,80}』|「[^」]{6,80}」")
AUTHOR_YEAR_RE = re.compile(r"[一-龯々ァ-ヴーA-Za-z][一-龯々ァ-ヴーA-Za-z・\s]{1,24}(?:\(|（)(?:19|20)\d{2}(?:\)|）)")


def check_citations(
    text: str,
    source_chunks: Iterable[dict[str, Any] | str] | None = None,
) -> CitationCheckResult:
    source_text = _combine_sources(source_chunks or [])
    sentences = _split_sentences(text)
    warnings: list[CitationWarning] = []
    annotated_parts: list[str] = []

    for sentence in sentences:
        triggers = _citation_triggers(sentence)
        if triggers and SOURCE_MARKER not in sentence and not _has_source_support(sentence, triggers, source_text):
            trigger = "、".join(triggers)
            warnings.append(
                CitationWarning(
                    sentence=sentence.strip(),
                    trigger=trigger,
                    reason="source corpusで確認できない具体情報または引用表現がある",
                )
            )
            annotated_parts.append(_append_marker(sentence))
        else:
            annotated_parts.append(sentence)
    return CitationCheckResult(text="".join(annotated_parts), warnings=warnings)


def _citation_triggers(sentence: str) -> list[str]:
    triggers: list[str] = []
    if YEAR_RE.search(sentence):
        triggers.append("year")
    if STAT_RE.search(sentence):
        triggers.append("statistic")
    if ACCORDING_RE.search(sentence):
        triggers.append("according_to")
    if TITLE_RE.search(sentence):
        triggers.append("title")
    if AUTHOR_YEAR_RE.search(sentence):
        triggers.append("author_year")
    return triggers


def _has_source_support(sentence: str, triggers: list[str], source_text: str) -> bool:
    if not source_text.strip():
        return False
    for year in YEAR_RE.findall(sentence):
        if year not in source_text and year.rstrip("年") not in source_text:
            return False
    for stat in STAT_RE.findall(sentence):
        if YEAR_RE.fullmatch(stat):
            continue
        compact = re.sub(r"\s+", "", stat)
        if compact not in re.sub(r"\s+", "", source_text):
            return False
    titles = TITLE_RE.findall(sentence)
    for title in titles:
        bare = title[1:-1]
        if bare not in source_text:
            return False
    if "according_to" in triggers or "author_year" in triggers:
        if titles:
            return True
        key_terms = _content_terms(sentence)
        if key_terms and len(set(key_terms) & set(_content_terms(source_text))) < min(2, len(key_terms)):
            return False
    return True


def _combine_sources(source_chunks: Iterable[dict[str, Any] | str]) -> str:
    texts: list[str] = []
    for chunk in source_chunks:
        if isinstance(chunk, str):
            texts.append(chunk)
        else:
            texts.extend(
                str(chunk.get(key, ""))
                for key in (
                    "text",
                    "title",
                    "source_file",
                    "source_url",
                    "landing_url",
                    "published_date",
                    "publisher",
                )
            )
    return "\n".join(texts)


def _split_sentences(text: str) -> list[str]:
    return [item for item in re.split(r"(?<=[。！？\n])", text) if item]


def _append_marker(sentence: str) -> str:
    match = re.search(r"([。！？\n]\s*)$", sentence)
    if match:
        return sentence[: match.start(1)] + SOURCE_MARKER + match.group(1)
    return sentence + SOURCE_MARKER


def _content_terms(text: str) -> list[str]:
    terms = re.findall(r"[一-龯々ァ-ヴーA-Za-z0-9]{2,}", text)
    stop = {"これ", "ため", "こと", "もの", "よう", "によれば", "によると"}
    return [term for term in terms if term not in stop]
