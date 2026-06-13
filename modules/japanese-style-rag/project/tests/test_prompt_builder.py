from jstyle_rag.generation.prompt_builder import build_report_prompt


def test_prompt_builder_contains_copy_and_citation_boundaries() -> None:
    prompt = build_report_prompt(
        topic="SNSが若者のコミュニケーションに与える影響",
        word_count=1600,
        discipline="sociology",
        target_style="undergraduate_report",
        style_profiles=[],
        source_chunks=[],
    )

    assert "不要复制 style corpus" in prompt
    assert "不要编造引用" in prompt
    assert "style profiles は文体の抽象的参考" in prompt
    assert "report_template は構成・評価観点のみ" in prompt
    assert "course_slide/lecture_note/course_handout は授業文脈" in prompt
    assert "book/textbook は概念・理論枠組み" in prompt
    assert "[要出典確認]" in prompt


def test_prompt_builder_includes_source_type_guidance() -> None:
    prompt = build_report_prompt(
        topic="SDNの安全性",
        word_count=1200,
        discipline="information_science",
        target_style="undergraduate_report",
        source_chunks=[
            {
                "chunk_id": "paper-1",
                "source_file": "papers/sdn.pdf",
                "source_type": "academic_paper",
                "authority_level": "peer_reviewed",
                "citation_role": "prior_research",
                "title": "SDN Security Paper",
                "source_url": "https://example.org/sdn.pdf",
                "published_date": "2025",
                "publisher": "Example Journal",
                "text": "SDNは制御プレーンとデータプレーンを分離する。",
            }
        ],
    )

    assert "academic_paper は先行研究" in prompt
    assert "title: SDN Security Paper" in prompt
    assert "source_url: https://example.org/sdn.pdf" in prompt
    assert "source_type: academic_paper" in prompt
    assert "citation_role: prior_research" in prompt
