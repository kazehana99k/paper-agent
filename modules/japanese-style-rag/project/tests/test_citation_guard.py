from jstyle_rag.sources.citation_guard import SOURCE_MARKER, check_citations


def test_citation_guard_marks_unsourced_years() -> None:
    text = "山田によれば、2020年にSNS利用者は30%増加した。"

    result = check_citations(text, source_chunks=[])

    assert SOURCE_MARKER in result.text
    assert result.warnings
    assert result.warnings[0].trigger


def test_citation_guard_allows_supported_years_and_stats() -> None:
    text = "資料によれば、2020年にSNS利用者は30%増加した。"
    sources = [{"text": "2020年にSNS利用者は30%増加した。"}]

    result = check_citations(text, source_chunks=sources)

    assert SOURCE_MARKER not in result.text
    assert result.warnings == []


def test_citation_guard_uses_source_metadata() -> None:
    text = "IPAの『情報セキュリティ10大脅威 2025 解説書』によれば、2025年の組織向け脅威が整理されている。"
    sources = [
        {
            "text": "組織向け脅威を整理した解説書。",
            "title": "情報セキュリティ10大脅威 2025 解説書",
            "published_date": "2025-02",
            "publisher": "IPA",
        }
    ]

    result = check_citations(text, source_chunks=sources)

    assert SOURCE_MARKER not in result.text
    assert result.warnings == []
