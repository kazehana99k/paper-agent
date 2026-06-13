from pathlib import Path

from jstyle_rag.config import get_config
from jstyle_rag.module import (
    build_task_requirements,
    ensure_module_directories,
    import_material,
    module_status,
    task_preset,
)


def test_report_task_preset_names_required_materials() -> None:
    preset = task_preset("report")

    assert preset["target_style"] == "undergraduate_report"
    assert "report_template" in preset["required_materials"]
    assert "course_slide" in preset["required_materials"]
    assert "book" in preset["required_materials"]


def test_task_requirements_include_course_and_assignment() -> None:
    text = build_task_requirements(
        task_type="report",
        requirements="1600字程度",
        course_name="情報社会論",
        assignment="授業スライドを踏まえる",
    )

    assert "授業レポート" in text
    assert "情報社会論" in text
    assert "授業スライドを踏まえる" in text
    assert "Required material roles" in text


def test_import_material_writes_role_sidecar(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("JSTYLE_RAG_ROOT", str(tmp_path))
    source = tmp_path / "slide.txt"
    source.write_text("講義資料: SNSと社会", encoding="utf-8")

    result = import_material(str(source), "course_slide", title="第1回スライド")

    cfg = get_config()
    sidecar = cfg.source_raw_dir / result["sidecar"]
    assert sidecar.exists()
    assert result["metadata"]["source_type"] == "course_slide"
    assert result["metadata"]["citation_role"] == "class_context"
    assert result["metadata"]["title"] == "第1回スライド"


def test_module_status_lists_material_roles(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("JSTYLE_RAG_ROOT", str(tmp_path))
    ensure_module_directories()

    status = module_status()

    assert {item["id"] for item in status["material_types"]} >= {"report_template", "course_slide", "book"}
    assert {item["id"] for item in status["task_presets"]} >= {"report", "literature_review"}
