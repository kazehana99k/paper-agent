from pathlib import Path

from jstyle_rag.sources.source_metadata import (
    classify_source_files,
    infer_source_metadata,
    load_sidecar_metadata,
    merge_source_metadata,
    write_sidecar_metadata,
)


def test_source_metadata_distinguishes_papers_from_reports() -> None:
    paper = infer_source_metadata("papers/jstage_network_security_paper.pdf", "本論文ではSDNの安全性を検討する。")
    report = infer_source_metadata("reports/ipa_2025_security_report.pdf", "情報セキュリティ10大脅威 報告書")

    assert paper.source_type == "academic_paper"
    assert paper.citation_role == "prior_research"
    assert report.source_type == "technical_report"
    assert report.citation_role == "factual_background"


def test_source_metadata_sidecar_override(tmp_path: Path) -> None:
    source = tmp_path / "network.pdf"
    sidecar = tmp_path / "network.pdf.meta.json"
    source.write_text("dummy", encoding="utf-8")
    sidecar.write_text(
        '{"source_type":"government_report","authority_level":"official","citation_role":"statistics","title":"Network Report"}',
        encoding="utf-8",
    )

    metadata = merge_source_metadata(infer_source_metadata("network.pdf"), load_sidecar_metadata(source))

    assert metadata["source_type"] == "government_report"
    assert metadata["authority_level"] == "official"
    assert metadata["citation_role"] == "statistics"
    assert metadata["title"] == "Network Report"


def test_arxiv_is_marked_as_preprint() -> None:
    metadata = infer_source_metadata("papers/arxiv/sdn_2502.13828.pdf")

    assert metadata.source_type == "academic_paper"
    assert metadata.authority_level == "preprint"
    assert metadata.citation_role == "prior_research"


def test_course_and_book_material_roles() -> None:
    slide = infer_source_metadata("course_slides/week1_slide.pdf", "講義資料")
    book = infer_source_metadata("books/network_textbook_chapter1.txt", "教科書")
    template = infer_source_metadata("templates/report_rubric.md", "評価基準")

    assert slide.source_type == "course_slide"
    assert slide.citation_role == "class_context"
    assert book.source_type == "book"
    assert book.citation_role == "theory_framework"
    assert template.source_type == "report_template"
    assert template.citation_role == "template_structure"


def test_classify_source_files_and_write_sidecar(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    raw.mkdir()
    source = raw / "network.txt"
    source.write_text("ネットワーク統計に関する公開資料", encoding="utf-8")

    write_sidecar_metadata(source, "government_report", "official", "statistics")
    rows = classify_source_files(raw)

    assert rows == [
        {
            "source_file": "network.txt",
            "sidecar": "network.txt.meta.json",
            "has_sidecar": "true",
            "source_type": "government_report",
            "authority_level": "official",
            "citation_role": "statistics",
        }
    ]
