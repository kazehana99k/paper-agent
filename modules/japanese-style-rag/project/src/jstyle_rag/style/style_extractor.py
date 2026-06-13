from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from jstyle_rag.loaders.pdf_loader import load_pdf_pages
from jstyle_rag.loaders.text_loader import TEXT_SUFFIXES, iter_supported_files, load_text_file

from .style_profile_schema import Discipline, DocType, StyleProfile, Tone


CONNECTIVES = [
    "一方で",
    "しかし",
    "ただし",
    "また",
    "さらに",
    "そのため",
    "したがって",
    "この点について",
    "以上より",
    "例えば",
    "つまり",
    "まず",
    "次に",
    "最後に",
]

ENDING_CANDIDATES = [
    "である",
    "であった",
    "であろう",
    "と考える",
    "と考えられる",
    "ではないだろうか",
    "と言える",
    "といえる",
    "必要がある",
    "必要である",
    "している",
    "されている",
    "になる",
    "でない",
    "だ",
    "です",
    "ます",
]


def extract_style_profile(text: str, source_file: str) -> StyleProfile:
    normalized = _normalize_text(text)
    style_id = _stable_id(source_file, normalized)
    sentences = _split_sentences(normalized)
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", normalized) if item.strip()]

    endings = _detect_sentence_endings(sentences)
    connectives = _detect_connectives(normalized)
    structures = _detect_structure(normalized)
    doc_type = _detect_doc_type(source_file, normalized)
    discipline = _detect_discipline(source_file, normalized)
    tone = _detect_tone(endings, structures, doc_type)
    anti_ai_notes = _anti_ai_notes(paragraphs, endings, connectives)
    summary = _make_summary(doc_type, discipline, endings, connectives, structures, tone)

    return StyleProfile(
        style_id=style_id,
        source_file=source_file,
        doc_type=doc_type,
        discipline=discipline,
        paragraph_length_pattern=_paragraph_pattern(paragraphs),
        sentence_ending_pattern=endings,
        connective_pattern=connectives,
        structure_pattern=structures,
        tone=tone,
        anti_ai_notes=anti_ai_notes,
        do_not_copy_examples=[],
        style_summary_ja=summary,
    )


def extract_style_profiles_from_dir(raw_dir: Path, output_jsonl: Path) -> list[StyleProfile]:
    profiles: list[StyleProfile] = []
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    for path in iter_supported_files(raw_dir):
        relative = str(path.relative_to(raw_dir))
        text = _load_style_text(path)
        if not text.strip():
            continue
        profiles.append(extract_style_profile(text, relative))

    with output_jsonl.open("w", encoding="utf-8") as handle:
        for profile in profiles:
            handle.write(json.dumps(profile.to_dict(), ensure_ascii=False) + "\n")
    return profiles


def extract_style_profile_from_file(path: Path, source_file: str | None = None) -> StyleProfile:
    text = _load_style_text(path)
    if not text.strip():
        raise ValueError(f"style sample has no extractable text: {path}")
    return extract_style_profile(text, source_file or path.name)


def append_style_profile_from_file(path: Path, output_jsonl: Path, source_file: str | None = None) -> StyleProfile:
    profile = extract_style_profile_from_file(path, source_file=source_file)
    existing = load_style_profiles(output_jsonl)
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with output_jsonl.open("w", encoding="utf-8") as handle:
        replaced = False
        for item in existing:
            if item.style_id == profile.style_id or item.source_file == profile.source_file:
                handle.write(json.dumps(profile.to_dict(), ensure_ascii=False) + "\n")
                replaced = True
            else:
                handle.write(json.dumps(item.to_dict(), ensure_ascii=False) + "\n")
        if not replaced:
            handle.write(json.dumps(profile.to_dict(), ensure_ascii=False) + "\n")
    return profile


def load_style_profiles(path: Path) -> list[StyleProfile]:
    if not path.exists():
        return []
    profiles: list[StyleProfile] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                profiles.append(StyleProfile.from_json(line))
    return profiles


def _load_style_text(path: Path) -> str:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return load_text_file(path)
    if path.suffix.lower() == ".pdf":
        return "\n\n".join(page_text for _, page_text in load_pdf_pages(path))
    raise ValueError(f"unsupported style sample type: {path.suffix}")


def _normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _stable_id(source_file: str, text: str) -> str:
    digest = hashlib.sha1(f"{source_file}\n{text[:2000]}".encode("utf-8")).hexdigest()
    return f"style-{digest[:12]}"


def _split_sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？])", text) if item.strip()]


def _detect_sentence_endings(sentences: list[str], limit: int = 6) -> list[str]:
    counts: Counter[str] = Counter()
    for sentence in sentences:
        cleaned = re.sub(r"[。！？\s]+$", "", sentence)
        for ending in ENDING_CANDIDATES:
            if cleaned.endswith(ending):
                counts[ending] += 1
                break
    return [item for item, _ in counts.most_common(limit)]


def _detect_connectives(text: str, limit: int = 8) -> list[str]:
    counts = Counter({connective: text.count(connective) for connective in CONNECTIVES})
    return [item for item, count in counts.most_common(limit) if count > 0]


def _detect_structure(text: str) -> list[str]:
    mapping = [
        ("問題提起", ["問題", "課題", "問い", "本レポートでは"]),
        ("背景", ["背景", "近年", "社会", "現状"]),
        ("先行研究", ["先行研究", "既存研究", "文献", "によれば"]),
        ("目的", ["目的", "明らかにする", "検討する"]),
        ("方法", ["方法", "調査", "分析", "対象"]),
        ("具体例", ["例えば", "事例", "具体的"]),
        ("考察", ["考察", "と考える", "示唆"]),
        ("まとめ", ["まとめ", "結論", "以上より", "本稿では"]),
    ]
    structure = [label for label, keywords in mapping if any(keyword in text for keyword in keywords)]
    return structure or ["問題提起", "考察", "まとめ"]


def _detect_doc_type(source_file: str, text: str) -> DocType:
    target = f"{source_file}\n{text[:1200]}"
    if any(keyword in target for keyword in ("研究計画", "研究目的", "研究方法", "計画書")):
        return "research_proposal"
    if any(keyword in target for keyword in ("文献調査", "先行研究", "レビュー", "literature review")):
        return "literature_review"
    if any(keyword in target for keyword in ("卒業論文", "修士論文", "博士論文", "thesis")):
        return "thesis"
    if any(keyword in target for keyword in ("レポート", "課題", "講義")):
        return "undergraduate_report"
    return "unknown"


def _detect_discipline(source_file: str, text: str) -> Discipline:
    target = f"{source_file}\n{text[:3000]}".lower()
    if any(keyword in target for keyword in ("情報", "ai", "機械学習", "データ", "アルゴリズム", "プログラム")):
        return "information_science"
    if any(keyword in target for keyword in ("社会", "若者", "コミュニケーション", "家族", "地域", "階層")):
        return "sociology"
    if any(keyword in target for keyword in ("経営", "企業", "市場", "マーケティング", "会計", "business")):
        return "business"
    if any(keyword in target for keyword in ("一般教養", "教養", "総合")):
        return "general"
    return "unknown"


def _detect_tone(endings: list[str], structures: list[str], doc_type: DocType) -> Tone:
    if doc_type == "thesis" or "方法" in structures and "先行研究" in structures:
        return "thesis_like"
    if any(ending in endings for ending in ("である", "であった", "であろう")):
        return "formal_academic"
    if any(ending in endings for ending in ("と考える", "だ")):
        return "student_report"
    return "natural_academic"


def _paragraph_pattern(paragraphs: list[str]) -> str:
    if not paragraphs:
        return "段落情報は少なく、判定不能。"
    lengths = [len(re.sub(r"\s+", "", paragraph)) for paragraph in paragraphs]
    avg = sum(lengths) / len(lengths)
    variation = max(lengths) - min(lengths) if len(lengths) > 1 else 0
    if avg < 180:
        base = "短めの段落を積み重ねる傾向"
    elif avg < 420:
        base = "中程度の長さの段落で論点を区切る傾向"
    else:
        base = "長めの段落で説明と考察をまとめる傾向"
    if variation < max(80, avg * 0.25):
        return f"{base}。段落長は比較的そろっている。"
    return f"{base}。段落ごとの長短に変化がある。"


def _anti_ai_notes(paragraphs: list[str], endings: list[str], connectives: list[str]) -> list[str]:
    notes = [
        "style corpusの原文表現は生成本文にコピーしない",
        "具体的事実はsource corpusで確認できる範囲に限定する",
    ]
    if endings and endings[0] in {"と考えられる", "と言える", "といえる"}:
        notes.append(f"avoid repetitive {endings[0]}")
    if len(paragraphs) >= 4:
        lengths = [len(re.sub(r"\s+", "", paragraph)) for paragraph in paragraphs]
        avg = sum(lengths) / len(lengths)
        if max(lengths) - min(lengths) < max(60, avg * 0.2):
            notes.append("avoid uniform paragraph length")
    if {"まず", "次に", "最後に"}.issubset(set(connectives)):
        notes.append("avoid mechanical まず・次に・最後に sequencing")
    return notes


def _make_summary(
    doc_type: DocType,
    discipline: Discipline,
    endings: list[str],
    connectives: list[str],
    structures: list[str],
    tone: Tone,
) -> str:
    ending_text = "、".join(endings[:3]) if endings else "文末傾向は弱い"
    connective_text = "、".join(connectives[:4]) if connectives else "接続表現は控えめ"
    structure_text = "、".join(structures)
    return (
        f"{discipline}領域の{doc_type}に近い文体。"
        f"文末は{ending_text}が目立ち、接続は{connective_text}を使う傾向がある。"
        f"構成は{structure_text}の流れを取りやすく、全体の調子は{tone}である。"
    )
