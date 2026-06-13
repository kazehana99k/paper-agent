from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Literal


DocType = Literal[
    "undergraduate_report",
    "research_proposal",
    "literature_review",
    "thesis",
    "unknown",
]
Discipline = Literal["information_science", "sociology", "business", "general", "unknown"]
Tone = Literal["natural_academic", "formal_academic", "student_report", "thesis_like"]


@dataclass(frozen=True)
class StyleProfile:
    style_id: str
    source_file: str
    doc_type: DocType = "unknown"
    discipline: Discipline = "unknown"
    paragraph_length_pattern: str = ""
    sentence_ending_pattern: list[str] = field(default_factory=list)
    connective_pattern: list[str] = field(default_factory=list)
    structure_pattern: list[str] = field(default_factory=list)
    tone: Tone = "natural_academic"
    anti_ai_notes: list[str] = field(default_factory=list)
    do_not_copy_examples: list[str] = field(default_factory=list)
    style_summary_ja: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: dict) -> "StyleProfile":
        return cls(**data)

    @classmethod
    def from_json(cls, line: str) -> "StyleProfile":
        return cls.from_dict(json.loads(line))
