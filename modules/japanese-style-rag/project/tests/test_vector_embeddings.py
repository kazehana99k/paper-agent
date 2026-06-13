from jstyle_rag import vector as vector_module
from jstyle_rag.vector import EmbeddingModel


def test_openai_compatible_embedding_backend_calls_embeddings_endpoint(monkeypatch) -> None:
    captured = {}

    def fake_post_json(url, payload, headers=None):
        captured["url"] = url
        captured["payload"] = payload
        captured["headers"] = headers or {}
        return {
            "data": [
                {"index": 0, "embedding": [1.0, 0.0, 0.0]},
                {"index": 1, "embedding": [0.0, 1.0, 0.0]},
            ]
        }

    monkeypatch.setattr(vector_module, "_post_json", fake_post_json)

    model = EmbeddingModel(
        "openai:qwen3-embedding",
        allow_hash_fallback=False,
        openai_base_url="http://127.0.0.1:8001/v1",
        openai_api_key="test-key",
    )

    vectors = model.encode(["SNSと社会", "量子情報"])

    assert model.backend == "openai-compatible"
    assert captured["url"] == "http://127.0.0.1:8001/v1/embeddings"
    assert captured["payload"] == {"model": "qwen3-embedding", "input": ["SNSと社会", "量子情報"]}
    assert captured["headers"] == {"Authorization": "Bearer test-key"}
    assert vectors == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
