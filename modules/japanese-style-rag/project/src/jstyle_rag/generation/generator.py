from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from jstyle_rag.config import AppConfig, get_config


@dataclass(frozen=True)
class GeneratedReportText:
    outline: str
    draft: str
    raw_response: str = ""


class ReportGenerator:
    def __init__(self, config: AppConfig | None = None):
        self.config = config or get_config()

    def generate(
        self,
        prompt: str,
        topic: str,
        word_count: int,
        requirements: str = "",
        user_points: list[str] | None = None,
        source_chunks: list[dict[str, Any]] | None = None,
    ) -> GeneratedReportText:
        provider = self.config.llm_provider
        if provider == "ollama":
            return self._generate_ollama(prompt)
        if provider in {"openai", "openai-compatible", "openai_compatible"}:
            return self._generate_openai_compatible(prompt)
        return self._generate_offline(topic, word_count, requirements, user_points or [], source_chunks or [])

    def _generate_ollama(self, prompt: str) -> GeneratedReportText:
        payload = {
            "model": self.config.ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        url = f"{self.config.ollama_base_url}/api/chat"
        text = _post_json(url, payload)["message"]["content"]
        return _parse_generated_text(text)

    def _generate_openai_compatible(self, prompt: str) -> GeneratedReportText:
        payload = {
            "model": self.config.openai_model,
            "messages": [
                {
                    "role": "system",
                    "content": "You write Japanese university report drafts with strict source grounding.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.4,
        }
        headers = {}
        if self.config.openai_api_key:
            headers["Authorization"] = f"Bearer {self.config.openai_api_key}"
        url = f"{self.config.openai_base_url}/chat/completions"
        text = _post_json(url, payload, headers=headers)["choices"][0]["message"]["content"]
        return _parse_generated_text(text)

    def _generate_offline(
        self,
        topic: str,
        word_count: int,
        requirements: str,
        user_points: list[str],
        source_chunks: list[dict[str, Any]],
    ) -> GeneratedReportText:
        outline_items = [
            "問題提起とテーマの範囲",
            "source corpusから確認できる背景",
            "ユーザーの観点を踏まえた考察",
            "残る課題とまとめ",
        ]
        outline = "\n".join(f"- {item}" for item in outline_items)
        source_notes = _source_notes(source_chunks)
        user_note = " ".join(user_points) if user_points else "利用者の立場や問題意識を明確にしながら検討する。"
        target = max(600, min(word_count, 2200))
        paragraphs = [
            (
                f"{topic}について考える際には、まずテーマの範囲を限定し、技術的な仕組み、運用上の課題、"
                f"社会的な影響を分けて整理する必要がある。{requirements or '大学のレポート'}としては、一般的な印象にとどめず、"
                "確認できる資料と自分の問題意識を分けて整理することが重要である。"
            ),
            (
                "source corpusで確認できる範囲では、次の点が材料になる。"
                f"{source_notes if source_notes else '現時点では利用可能な資料が少ないため、具体的な年・統計・研究名は追加しない。'}"
            ),
            (
                f"利用者の観点としては、{user_note} この見方は、単に技術を肯定または否定するのではなく、"
                "使われる場面や相手との関係によって影響が変わるという点を意識している。"
            ),
            (
                "以上の点を踏まえると、本文では資料で確認できる事実と、そこから導かれる考察を切り分ける必要がある。"
                "source corpusにない作者名、年、統計、論文名を補ってしまうと、レポートの信頼性が下がる。"
                "不足している情報は[要出典確認]として残し、後で授業資料や論文を確認する形にする。"
            ),
        ]
        draft = "\n\n".join(_expand_to_length(paragraphs, target))
        return GeneratedReportText(outline=outline, draft=draft, raw_response="offline_fallback")


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM request failed: {exc}") from exc


def _parse_generated_text(text: str) -> GeneratedReportText:
    outline_match = re.search(r"##\s*Outline\s*(.*?)(?=##\s*Draft|$)", text, re.S | re.I)
    draft_match = re.search(r"##\s*Draft\s*(.*)$", text, re.S | re.I)
    if outline_match or draft_match:
        return GeneratedReportText(
            outline=(outline_match.group(1).strip() if outline_match else ""),
            draft=(draft_match.group(1).strip() if draft_match else text.strip()),
            raw_response=text,
        )
    return GeneratedReportText(outline="", draft=text.strip(), raw_response=text)


def _source_notes(source_chunks: list[dict[str, Any]]) -> str:
    notes: list[str] = []
    seen: set[tuple[str, str]] = set()
    for chunk in source_chunks:
        source_file = str(chunk.get("source_file", ""))
        page = str(chunk.get("page", ""))
        key = (source_file, page)
        if key in seen:
            continue
        seen.add(key)
        title = chunk.get("title", "") or source_file
        source_type = chunk.get("source_type", "unknown")
        citation = f"（{title}{', p.' + page if page else ''}）"
        themes = _abstract_source_themes(str(chunk.get("text", "")))
        if not themes:
            continue
        notes.append(f"{source_type}資料として、{themes}が確認できる{citation}。")
        if len(notes) >= 3:
            break
    return " ".join(notes)


def _abstract_source_themes(text: str) -> str:
    compact = " ".join(text.split())
    lowered = compact.lower()
    themes: list[str] = []
    keyword_themes = [
        ("ランサム", "ランサムウェア/ランサム攻撃の被害と組織対応"),
        ("ransom", "ランサムウェア/ランサム攻撃の被害と組織対応"),
        ("ddos", "DDoS 攻撃や複数の脅迫を組み合わせる手口"),
        ("脆弱", "脆弱性対策や公開ポート管理などのネットワーク運用リスク"),
        ("vpn", "VPN などのネットワーク接続点をめぐる侵入リスク"),
        ("不正アクセス", "不正アクセスへの監視と初動対応"),
        ("インシデント", "インシデント報告や対応状況"),
        ("tsubame", "インターネット定点観測に基づく観測傾向"),
        ("6g", "6G ネットワークの設計課題"),
        ("network slicing", "ネットワークスライシングの設計・運用課題"),
        ("software-defined networking", "SDN のソフトウェアセキュリティ上の論点"),
        ("sdn", "SDN のソフトウェアセキュリティ上の論点"),
        ("iot", "IoT 環境におけるアクセス制御とエッジ処理"),
        ("edge computing", "エッジコンピューティング環境のアクセス制御"),
    ]
    for keyword, theme in keyword_themes:
        if keyword in lowered or keyword in compact:
            themes.append(theme)
    if themes:
        return "、".join(dict.fromkeys(themes[:3]))

    terms = re.findall(r"[一-龯々ァ-ヴーA-Za-z0-9][一-龯々ァ-ヴーA-Za-z0-9・/-]{2,}", compact)
    stop = {"こと", "ため", "これ", "また", "する", "ある", "いる", "れる", "the", "and", "for", "with"}
    selected = [term for term in terms if term.lower() not in stop][:4]
    if selected:
        return "、".join(selected) + "に関する記述"
    return ""


def _expand_to_length(paragraphs: list[str], target: int) -> list[str]:
    if sum(len(paragraph) for paragraph in paragraphs) >= target * 0.55:
        return paragraphs
    extra = (
        "この段階の草稿では、断定を急ぐよりも、どの資料に基づく記述なのかを明確にする。"
        "そのうえで、資料から言える範囲と自分の考察を分けて述べることで、自然な大学レポートの形に近づく。"
    )
    expanded = paragraphs[:]
    while sum(len(paragraph) for paragraph in expanded) < target * 0.55 and len(expanded) < 8:
        expanded.insert(-1, extra)
    return expanded
