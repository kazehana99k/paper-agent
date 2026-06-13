from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from jstyle_rag.sources.citation_guard import SOURCE_MARKER, check_citations
from jstyle_rag.sources.source_metadata import infer_source_metadata
from jstyle_rag.style.similarity_guard import check_similarity
from jstyle_rag.vector import EmbeddingModel


def main() -> None:
    checks = [
        _check_unsourced_citation_is_marked(),
        _check_supported_citation_passes(),
        _check_similarity_guard_flags_overlap(),
        _check_source_metadata_roles(),
    ]
    failed = [check for check in checks if not check["passed"]]
    print(json.dumps({"passed": len(failed) == 0, "checks": checks}, ensure_ascii=False, indent=2))
    if failed:
        raise SystemExit(1)


def _check_unsourced_citation_is_marked() -> dict[str, object]:
    result = check_citations("山田によれば、2020年に攻撃件数は30%増加した。", [])
    return {
        "name": "unsourced_citation_is_marked",
        "passed": SOURCE_MARKER in result.text and bool(result.warnings),
        "warnings": [warning.to_dict() for warning in result.warnings],
    }


def _check_supported_citation_passes() -> dict[str, object]:
    result = check_citations(
        "資料によれば、2020年に攻撃件数は30%増加した。",
        [{"text": "2020年に攻撃件数は30%増加した。"}],
    )
    return {
        "name": "supported_citation_passes",
        "passed": SOURCE_MARKER not in result.text and not result.warnings,
        "warnings": [warning.to_dict() for warning in result.warnings],
    }


def _check_similarity_guard_flags_overlap() -> dict[str, object]:
    text = "近年、ネットワーク攻撃は組織の事業継続に大きな影響を与えている。この点について慎重に検討する必要がある。"
    warnings = check_similarity(text, [text], embedding_model=EmbeddingModel("hash"))
    return {
        "name": "similarity_guard_flags_overlap",
        "passed": bool(warnings),
        "warnings": [warning.to_dict() for warning in warnings],
    }


def _check_source_metadata_roles() -> dict[str, object]:
    paper = infer_source_metadata("papers/sdn_security_paper.pdf")
    report = infer_source_metadata("reports/jpcert_2025_quarterly_report.pdf")
    passed = (
        paper.source_type == "academic_paper"
        and paper.citation_role == "prior_research"
        and report.source_type == "technical_report"
        and report.citation_role == "factual_background"
    )
    return {
        "name": "source_metadata_roles",
        "passed": passed,
        "paper": paper.to_dict(),
        "report": report.to_dict(),
    }


if __name__ == "__main__":
    main()
