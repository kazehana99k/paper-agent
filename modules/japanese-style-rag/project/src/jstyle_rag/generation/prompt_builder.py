from __future__ import annotations

from typing import Any


def build_report_prompt(
    topic: str,
    word_count: int,
    discipline: str,
    target_style: str,
    requirements: str = "",
    user_points: list[str] | None = None,
    style_profiles: list[dict[str, Any]] | None = None,
    template_chunks: list[dict[str, Any]] | None = None,
    source_chunks: list[dict[str, Any]] | None = None,
) -> str:
    user_points = user_points or []
    style_profiles = style_profiles or []
    template_chunks = template_chunks or []
    source_chunks = source_chunks or []

    return "\n".join(
        [
            "# Task",
            "あなたは日本大学レポート草稿の作成を補助している。",
            f"テーマ: {topic}",
            f"目標字数: 約{word_count}字",
            f"分野: {discipline}",
            f"目標文体: {target_style}",
            f"追加要件: {requirements or '指定なし'}",
            "",
            "# Non-negotiable Boundaries",
            "- style profiles は文体の抽象的参考であり、内容・事実・引用の出典ではない。",
            "- 不要复制 style corpus の原文・言い回し・段落構成をそのまま使わない。",
            "- 具体的事実、作者名、年、統計、定義、論文名は source corpus またはユーザー入力に基づく。",
            "- report_template は構成・評価観点のみで、事実根拠ではない。",
            "- course_slide/lecture_note/course_handout は授業文脈、book/textbook は概念・理論枠組み、academic_paper は先行研究、government_report/technical_report/white_paper は背景・統計・技術動向として使い分ける。",
            "- 不要编造引用。存在しない論文、作者、年、統計データを作らない。",
            "- source corpus で確認できない具体情報は [要出典確認] と明示する。",
            "- AIらしい反復句を避ける。特に「本レポートでは」「以上より」「重要であると考えられる」「と言える」「まず、次に、最後に」「が必要である」を機械的に繰り返さない。",
            "- 自然な日本大学レポート調を保ち、過度に口語化しない。",
            "",
            "# User Points",
            _format_user_points(user_points),
            "",
            "# Abstract Style Profiles",
            _format_style_profiles(style_profiles),
            "",
            "# Report Template Snippets",
            _format_template_chunks(template_chunks),
            "",
            "# Source Corpus Snippets",
            _format_source_chunks(source_chunks),
            "",
            "# Output Format",
            "以下の形式で返すこと。",
            "## Outline",
            "箇条書きの構成案。",
            "## Draft",
            "本文草稿。出典が必要だがsource corpusで確認できない箇所は [要出典確認] を入れる。",
        ]
    )


def _format_user_points(user_points: list[str]) -> str:
    if not user_points:
        return "- 指定なし。"
    return "\n".join(f"- {point}" for point in user_points)


def _format_style_profiles(style_profiles: list[dict[str, Any]]) -> str:
    if not style_profiles:
        return "- 利用可能なstyle profileなし。一般的な自然な大学レポート調を用いる。"
    lines: list[str] = []
    for index, profile in enumerate(style_profiles, start=1):
        lines.extend(
            [
                f"## Style {index}: {profile.get('style_id', '')}",
                f"- doc_type: {profile.get('doc_type', 'unknown')}",
                f"- discipline: {profile.get('discipline', 'unknown')}",
                f"- tone: {profile.get('tone', 'natural_academic')}",
                f"- paragraph_length_pattern: {profile.get('paragraph_length_pattern', '')}",
                f"- sentence_ending_pattern: {', '.join(profile.get('sentence_ending_pattern', []))}",
                f"- connective_pattern: {', '.join(profile.get('connective_pattern', []))}",
                f"- structure_pattern: {', '.join(profile.get('structure_pattern', []))}",
                f"- anti_ai_notes: {', '.join(profile.get('anti_ai_notes', []))}",
                f"- style_summary_ja: {profile.get('style_summary_ja', '')}",
            ]
        )
    return "\n".join(lines)


def _format_template_chunks(template_chunks: list[dict[str, Any]]) -> str:
    if not template_chunks:
        return "- 利用可能なreport templateなし。"
    lines = [
        "- 以下は構成・見出し・段落粒度・提出情報の参考だけに使う。",
        "- 事実、数値、結論、実験内容、講義内容の根拠にはしない。",
        "- 文や段落をそのままコピーしない。",
    ]
    for index, chunk in enumerate(template_chunks, start=1):
        source_file = chunk.get("source_file", "")
        page = chunk.get("page", "")
        title = chunk.get("title", "")
        text = _trim(str(chunk.get("text", "")), 650)
        lines.extend(
            [
                f"## Template {index}",
                f"- title: {title}",
                f"- source_file: {source_file}",
                f"- page: {page}",
                f"- structure_text: {text}",
            ]
        )
    return "\n".join(lines)


def _format_source_chunks(source_chunks: list[dict[str, Any]]) -> str:
    if not source_chunks:
        return "- 利用可能なsource corpusなし。具体的事実はユーザー入力以外から追加しない。"
    lines: list[str] = []
    for index, chunk in enumerate(source_chunks, start=1):
        source_file = chunk.get("source_file", "")
        page = chunk.get("page", "")
        section = chunk.get("section", "")
        chunk_id = chunk.get("chunk_id", "")
        source_type = chunk.get("source_type", "unknown")
        authority_level = chunk.get("authority_level", "unknown")
        citation_role = chunk.get("citation_role", "unknown")
        title = chunk.get("title", "")
        source_url = chunk.get("source_url", "")
        published_date = chunk.get("published_date", "")
        publisher = chunk.get("publisher", "")
        text = _trim(str(chunk.get("text", "")), 1200)
        lines.extend(
            [
                f"## Source {index}",
                f"- title: {title}",
                f"- source_file: {source_file}",
                f"- source_url: {source_url}",
                f"- publisher: {publisher}",
                f"- published_date: {published_date}",
                f"- page: {page}",
                f"- section: {section}",
                f"- chunk_id: {chunk_id}",
                f"- source_type: {source_type}",
                f"- authority_level: {authority_level}",
                f"- citation_role: {citation_role}",
                f"- text: {text}",
            ]
        )
    return "\n".join(lines)


def _trim(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "..."
