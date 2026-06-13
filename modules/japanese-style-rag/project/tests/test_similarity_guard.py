from jstyle_rag.style.similarity_guard import check_similarity
from jstyle_rag.vector import EmbeddingModel


def test_similarity_guard_detects_high_overlap_with_style_chunk() -> None:
    generated = "近年、SNSは若者のコミュニケーションに大きな影響を与えている。この点について慎重に検討する必要がある。"
    style_chunk = "近年、SNSは若者のコミュニケーションに大きな影響を与えている。この点について慎重に検討する必要がある。"

    warnings = check_similarity(
        generated,
        style_chunks=[style_chunk],
        embedding_model=EmbeddingModel("hash"),
    )

    assert warnings
    assert warnings[0].ngram_overlap >= 0.58
