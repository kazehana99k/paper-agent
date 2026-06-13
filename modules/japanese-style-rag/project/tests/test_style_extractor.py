from jstyle_rag.style.style_extractor import extract_style_profile


def test_style_extractor_detects_japanese_endings_and_connectives() -> None:
    text = (
        "本レポートでは、SNSと若者の関係について検討する。\n\n"
        "近年、SNSは日常的な連絡手段である。一方で、対面での関係に影響する可能性もあると考える。"
        "しかし、その影響は利用場面によって異なる。"
    )

    profile = extract_style_profile(text, "sample_report.txt")

    assert "である" in profile.sentence_ending_pattern
    assert "と考える" in profile.sentence_ending_pattern
    assert "一方で" in profile.connective_pattern
    assert profile.do_not_copy_examples == []
