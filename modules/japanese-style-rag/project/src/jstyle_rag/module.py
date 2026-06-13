from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from jstyle_rag.config import AppConfig, ensure_directories, get_config
from jstyle_rag.sources.source_index import source_index_manifest
from jstyle_rag.sources.source_metadata import write_sidecar_metadata


MATERIAL_TYPES: list[dict[str, str | bool]] = [
    {
        "id": "report_template",
        "label": "Report Template",
        "target_dir": "templates",
        "source_type": "report_template",
        "authority_level": "class_material",
        "citation_role": "template_structure",
        "factual_source": False,
        "description": "課題の構成、見出し、評価観点。事実根拠にはしない。",
    },
    {
        "id": "course_slide",
        "label": "Course Slide",
        "target_dir": "course_slides",
        "source_type": "course_slide",
        "authority_level": "class_material",
        "citation_role": "class_context",
        "factual_source": True,
        "description": "授業スライド。授業文脈、用語、課題の射程を支える。",
    },
    {
        "id": "lecture_note",
        "label": "Lecture Note",
        "target_dir": "lecture_notes",
        "source_type": "lecture_note",
        "authority_level": "class_material",
        "citation_role": "class_context",
        "factual_source": True,
        "description": "講義ノート・配布資料。授業文脈と説明枠組みに使う。",
    },
    {
        "id": "course_handout",
        "label": "Course Handout",
        "target_dir": "course_handouts",
        "source_type": "course_handout",
        "authority_level": "class_material",
        "citation_role": "assignment_requirements",
        "factual_source": True,
        "description": "課題要項・配布資料。要求条件と評価観点に使う。",
    },
    {
        "id": "book",
        "label": "Book / Textbook",
        "target_dir": "books",
        "source_type": "book",
        "authority_level": "textbook",
        "citation_role": "theory_framework",
        "factual_source": True,
        "description": "教科書・書籍。定義、理論枠組み、概念整理に使う。",
    },
    {
        "id": "academic_paper",
        "label": "Academic Paper",
        "target_dir": "papers",
        "source_type": "academic_paper",
        "authority_level": "peer_reviewed",
        "citation_role": "prior_research",
        "factual_source": True,
        "description": "論文。先行研究・関連研究の整理に使う。",
    },
    {
        "id": "public_report",
        "label": "Public / Technical Report",
        "target_dir": "reports",
        "source_type": "technical_report",
        "authority_level": "institutional",
        "citation_role": "factual_background",
        "factual_source": True,
        "description": "白書・技術報告・公的資料。背景、統計、技術動向に使う。",
    },
    {
        "id": "user_note",
        "label": "User Note",
        "target_dir": "user_notes",
        "source_type": "user_note",
        "authority_level": "user_provided",
        "citation_role": "viewpoint_support",
        "factual_source": False,
        "description": "利用者の観点・メモ。主張や考察の材料に使う。",
    },
]


TASK_PRESETS: list[dict[str, Any]] = [
    {
        "id": "report",
        "label": "授業レポート",
        "target_style": "undergraduate_report",
        "default_word_count": 1600,
        "required_materials": ["report_template", "course_slide", "lecture_note", "book"],
        "recommended_materials": ["academic_paper", "public_report", "user_note"],
        "instruction_ja": (
            "授業レポートとして、課題要件、授業資料、教科書・講義ノート、"
            "必要に応じた外部資料を分けて扱う。授業資料は文脈、書籍は概念、"
            "論文は先行研究、公的報告は背景・統計として使う。"
        ),
    },
    {
        "id": "literature_review",
        "label": "文献レビュー",
        "target_style": "literature_review",
        "default_word_count": 2200,
        "required_materials": ["academic_paper"],
        "recommended_materials": ["book", "public_report", "user_note"],
        "instruction_ja": "文献レビューとして、先行研究を羅列せず、比較軸、方法、限界、未解決問題を整理する。",
    },
    {
        "id": "research_proposal",
        "label": "研究計画書",
        "target_style": "research_proposal",
        "default_word_count": 1800,
        "required_materials": ["academic_paper", "public_report"],
        "recommended_materials": ["book", "user_note"],
        "instruction_ja": "研究計画書として、背景、課題、目的、方法、評価観点、期待される貢献を対応させる。",
    },
]


def material_type(material_id: str) -> dict[str, Any]:
    for item in MATERIAL_TYPES:
        if item["id"] == material_id:
            return dict(item)
    raise ValueError(f"unknown material type: {material_id}")


def task_preset(task_id: str) -> dict[str, Any]:
    for item in TASK_PRESETS:
        if item["id"] == task_id:
            return dict(item)
    raise ValueError(f"unknown task preset: {task_id}")


def ensure_module_directories(config: AppConfig | None = None) -> None:
    cfg = config or get_config()
    ensure_directories(cfg)
    for item in MATERIAL_TYPES:
        (cfg.source_raw_dir / str(item["target_dir"])).mkdir(parents=True, exist_ok=True)
    task_dir(cfg).mkdir(parents=True, exist_ok=True)
    write_task_presets(cfg, overwrite=False)


def task_dir(config: AppConfig | None = None) -> Path:
    cfg = config or get_config()
    return cfg.data_dir / "task_templates"


def write_task_presets(config: AppConfig | None = None, overwrite: bool = False) -> Path:
    cfg = config or get_config()
    path = task_dir(cfg) / "task_presets.json"
    if path.exists() and not overwrite:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(TASK_PRESETS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def import_material(
    source_path: str | Path,
    material_id: str,
    title: str = "",
    publisher: str = "",
    published_date: str = "",
    source_url: str = "",
    config: AppConfig | None = None,
) -> dict[str, Any]:
    cfg = config or get_config()
    ensure_module_directories(cfg)
    material = material_type(material_id)
    src = Path(source_path).expanduser().resolve()
    if not src.exists() or not src.is_file():
        raise FileNotFoundError(f"material file does not exist: {src}")

    safe_name = _safe_name(src.name)
    target_dir = cfg.source_raw_dir / str(material["target_dir"])
    target = target_dir / safe_name
    if target.exists() and target.resolve() != src:
        digest = hashlib.sha1(src.read_bytes()).hexdigest()[:10]
        target = target_dir / f"{target.stem}-{digest}{target.suffix}"
    if src != target.resolve():
        shutil.copy2(src, target)

    sidecar = write_sidecar_metadata(
        target,
        str(material["source_type"]),
        str(material["authority_level"]),
        str(material["citation_role"]),
    )
    metadata = json.loads(sidecar.read_text(encoding="utf-8"))
    for key, value in {
        "title": title,
        "publisher": publisher,
        "published_date": published_date,
        "source_url": source_url,
        "module_material_type": material_id,
        "module_material_label": str(material["label"]),
    }.items():
        if value:
            metadata[key] = value
    sidecar.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "material_type": material,
        "source_file": str(target.relative_to(cfg.source_raw_dir)),
        "sidecar": str(sidecar.relative_to(cfg.source_raw_dir)),
        "metadata": metadata,
    }


def build_task_requirements(
    task_type: str = "report",
    requirements: str = "",
    course_name: str = "",
    assignment: str = "",
) -> str:
    preset = task_preset(task_type)
    parts = [
        f"Task preset: {preset['label']} ({preset['id']})",
        str(preset["instruction_ja"]),
        "Required material roles: " + ", ".join(preset["required_materials"]),
        "Recommended material roles: " + ", ".join(preset["recommended_materials"]),
    ]
    if course_name:
        parts.append(f"Course: {course_name}")
    if assignment:
        parts.append(f"Assignment: {assignment}")
    if requirements:
        parts.append(f"User requirements: {requirements}")
    return "\n".join(parts)


def module_status(config: AppConfig | None = None) -> dict[str, Any]:
    cfg = config or get_config()
    ensure_module_directories(cfg)
    material_rows: list[dict[str, Any]] = []
    for item in MATERIAL_TYPES:
        root = cfg.source_raw_dir / str(item["target_dir"])
        files = [
            str(path.relative_to(cfg.source_raw_dir))
            for path in sorted(root.rglob("*"))
            if path.is_file() and not path.name.endswith(".meta.json")
        ]
        material_rows.append({**item, "count": len(files), "files": files[:20]})

    outputs = sorted(cfg.outputs_dir.glob("*.json")) if cfg.outputs_dir.exists() else []
    return {
        "project_root": str(cfg.project_root),
        "embedding": {
            "backend": cfg.vector_backend,
            "model": cfg.embedding_model,
            "base_url": cfg.embedding_base_url,
            "allow_hash_embeddings": cfg.allow_hash_embeddings,
            "index_manifest": source_index_manifest(cfg),
        },
        "llm_provider": cfg.llm_provider,
        "material_types": MATERIAL_TYPES,
        "task_presets": TASK_PRESETS,
        "materials": material_rows,
        "outputs": [str(path.relative_to(cfg.project_root)) for path in outputs[-20:]],
    }


def _safe_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in name).strip()
    return cleaned or "material.txt"
