from __future__ import annotations

import json
from pathlib import Path

from jstyle_rag.config import AppConfig, get_config

from .style_index import default_profiles_path


SEED_STYLE_PROFILES = [
    {
        "style_id": "seed-undergraduate-report-information-science",
        "source_file": "synthetic_seed/information_science_undergraduate_report",
        "doc_type": "undergraduate_report",
        "discipline": "information_science",
        "paragraph_length_pattern": "中程度の段落で、定義、背景、具体例、考察を分ける。各段落は一つの論点に絞り、必要に応じて短い補足段落を挟む。",
        "sentence_ending_pattern": ["である", "と考える", "必要がある", "している"],
        "connective_pattern": ["まず", "また", "一方で", "そのため", "この点について"],
        "structure_pattern": ["問題提起", "背景", "具体例", "考察", "まとめ"],
        "tone": "student_report",
        "anti_ai_notes": [
            "style corpusの原文表現は生成本文にコピーしない",
            "技術用語の説明を一文で済ませず、授業理解と自分の観点を分ける",
            "avoid repetitive 重要であると考えられる",
            "avoid mechanical まず・次に・最後に sequencing",
        ],
        "do_not_copy_examples": [],
        "style_summary_ja": "情報科学系の学部レポート向け。専門用語を短く定義し、公開資料で確認できる背景と自分の考察を分けて述べる。断定しすぎず、最後に運用上または社会的な課題へつなげる。",
    },
    {
        "style_id": "seed-undergraduate-report-general",
        "source_file": "synthetic_seed/general_undergraduate_report",
        "doc_type": "undergraduate_report",
        "discipline": "general",
        "paragraph_length_pattern": "短めから中程度の段落を積み重ねる。導入は問題意識を明確にし、本論では資料の説明と自分の見解を交互に配置する。",
        "sentence_ending_pattern": ["である", "と考える", "ではないだろうか", "必要がある"],
        "connective_pattern": ["しかし", "また", "例えば", "この点について", "したがって"],
        "structure_pattern": ["問題提起", "背景", "具体例", "考察", "まとめ"],
        "tone": "natural_academic",
        "anti_ai_notes": [
            "style corpusの原文表現は生成本文にコピーしない",
            "抽象論だけで段落を終えず、source corpusに基づく材料を入れる",
            "avoid uniform paragraph length",
        ],
        "do_not_copy_examples": [],
        "style_summary_ja": "一般教養の大学レポート向け。硬すぎないである調を基本にし、身近な問題意識から資料に基づく説明へ進める。最後は結論だけでなく、残る課題も簡潔に述べる。",
    },
    {
        "style_id": "seed-literature-review-information-science",
        "source_file": "synthetic_seed/information_science_literature_review",
        "doc_type": "literature_review",
        "discipline": "information_science",
        "paragraph_length_pattern": "やや長めの段落で、研究領域、論点、比較、限界を整理する。段落冒頭で比較軸を示し、段落末で次の論点へつなげる。",
        "sentence_ending_pattern": ["である", "と考えられる", "されている", "必要がある"],
        "connective_pattern": ["一方で", "しかし", "さらに", "この点について", "したがって"],
        "structure_pattern": ["背景", "先行研究", "方法", "考察", "まとめ"],
        "tone": "formal_academic",
        "anti_ai_notes": [
            "style corpusの原文表現は生成本文にコピーしない",
            "preprintを査読済み論文として扱わない",
            "avoid repetitive と考えられる",
            "source corpusにない著者名・年・論文名を補わない",
        ],
        "do_not_copy_examples": [],
        "style_summary_ja": "情報科学系の文献調査向け。先行研究を羅列せず、技術課題、手法、限界の比較軸で整理する。arXivなどはpreprintとして慎重に扱い、出典の種類を明示する。",
    },
    {
        "style_id": "seed-research-proposal-information-science",
        "source_file": "synthetic_seed/information_science_research_proposal",
        "doc_type": "research_proposal",
        "discipline": "information_science",
        "paragraph_length_pattern": "目的、背景、研究課題、方法、期待される貢献を独立した段落で示す。各段落は短すぎず、調査対象と評価観点を具体化する。",
        "sentence_ending_pattern": ["である", "を明らかにする", "を検討する", "必要がある"],
        "connective_pattern": ["近年", "一方で", "そこで", "具体的には", "以上を踏まえ"],
        "structure_pattern": ["背景", "先行研究", "目的", "方法", "まとめ"],
        "tone": "thesis_like",
        "anti_ai_notes": [
            "style corpusの原文表現は生成本文にコピーしない",
            "研究目的と作業手順を混同しない",
            "根拠のない新規性主張を避ける",
        ],
        "do_not_copy_examples": [],
        "style_summary_ja": "情報科学系の研究計画書向け。背景から未解決課題へ進み、研究目的と方法を対応させる。実験、比較対象、評価指標が未定の場合は[要出典確認]や未確定事項として残す。",
    },
    {
        "style_id": "seed-undergraduate-report-sociology",
        "source_file": "synthetic_seed/sociology_undergraduate_report",
        "doc_type": "undergraduate_report",
        "discipline": "sociology",
        "paragraph_length_pattern": "中程度の段落で、社会的背景、具体的事例、資料に基づく説明、自分の考察を順に配置する。主観だけの段落を避ける。",
        "sentence_ending_pattern": ["である", "と考える", "ではないだろうか", "している"],
        "connective_pattern": ["一方で", "しかし", "また", "例えば", "この点について"],
        "structure_pattern": ["問題提起", "背景", "具体例", "考察", "まとめ"],
        "tone": "natural_academic",
        "anti_ai_notes": [
            "style corpusの原文表現は生成本文にコピーしない",
            "一般化しすぎる表現を避け、対象範囲を限定する",
            "avoid repetitive と言える",
        ],
        "do_not_copy_examples": [],
        "style_summary_ja": "社会学系の学部レポート向け。身近な問題から始めつつ、資料で確認できる範囲と自分の考察を区別する。結論では単純な賛否ではなく条件や限界を述べる。",
    },
]


def seed_style_profiles(config: AppConfig | None = None, overwrite: bool = False) -> Path:
    cfg = config or get_config()
    path = default_profiles_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        existing = {
            json.loads(line)["style_id"]
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
    else:
        existing = set()

    mode = "w" if overwrite else "a"
    with path.open(mode, encoding="utf-8") as handle:
        for profile in SEED_STYLE_PROFILES:
            if profile["style_id"] in existing:
                continue
            handle.write(json.dumps(profile, ensure_ascii=False) + "\n")
    return path
