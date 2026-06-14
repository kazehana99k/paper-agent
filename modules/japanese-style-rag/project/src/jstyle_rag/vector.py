from __future__ import annotations

import hashlib
import json
import math
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


def tokenize_for_embedding(text: str) -> list[str]:
    normalized = re.sub(r"\s+", "", text.lower())
    tokens = re.findall(r"[a-z0-9_]+", text.lower())
    tokens.extend(normalized[i : i + 2] for i in range(max(0, len(normalized) - 1)))
    tokens.extend(normalized[i : i + 3] for i in range(max(0, len(normalized) - 2)))
    return [token for token in tokens if token]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class EmbeddingModel:
    """Embedding wrapper with OpenAI-compatible, sentence-transformers, and hash backends."""

    def __init__(
        self,
        model_name: str,
        allow_hash_fallback: bool = True,
        dim: int = 384,
        openai_base_url: str = "",
        openai_api_key: str = "",
    ):
        self.model_name = model_name.strip()
        self.allow_hash_fallback = allow_hash_fallback
        self.dim = dim
        self._model = None
        self._openai_model = ""
        self._openai_base_url = openai_base_url.rstrip("/")
        self._openai_api_key = openai_api_key
        self.backend = "hash"
        if self.model_name in {"hash", "local-hash", "__hash__"}:
            return
        openai_model = _strip_openai_embedding_prefix(self.model_name)
        if openai_model is not None:
            self._openai_model = openai_model or os.getenv("JSTYLE_EMBEDDING_API_MODEL", "")
            if not self._openai_model:
                raise RuntimeError("OpenAI-compatible embeddings require a model name")
            self._openai_base_url = (
                self._openai_base_url
                or os.getenv("JSTYLE_EMBEDDING_BASE_URL", "")
                or "http://127.0.0.1:8001/v1"
            ).rstrip("/")
            self.backend = "openai-compatible"
            return
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore

            self._model = SentenceTransformer(self.model_name)
            self.backend = "sentence-transformers"
        except Exception:
            if not allow_hash_fallback:
                raise

    def encode(self, texts: str | Iterable[str]) -> list[float] | list[list[float]]:
        single = isinstance(texts, str)
        items = [texts] if single else list(texts)
        if self._model is not None:
            vectors = self._model.encode(items, normalize_embeddings=True)
            result = [list(map(float, vector)) for vector in vectors]
        elif self._openai_model:
            result = self._openai_embed(items)
        else:
            result = [self._hash_embed(item) for item in items]
        return result[0] if single else result

    def _openai_embed(self, texts: list[str]) -> list[list[float]]:
        payload = {"model": self._openai_model, "input": texts}
        headers: dict[str, str] = {}
        if self._openai_api_key:
            headers["Authorization"] = f"Bearer {self._openai_api_key}"
        response = _post_json(f"{self._openai_base_url}/embeddings", payload, headers=headers)
        rows = response.get("data")
        if not isinstance(rows, list):
            raise RuntimeError("embedding response missing data[]")
        rows = sorted(rows, key=lambda row: int(row.get("index", 0)) if isinstance(row, dict) else 0)
        embeddings: list[list[float]] = []
        for row in rows:
            if not isinstance(row, dict):
                raise RuntimeError("embedding response row is not an object")
            vector = row.get("embedding")
            if not isinstance(vector, list):
                raise RuntimeError("embedding response row missing embedding")
            values = [float(value) for value in vector]
            if not values or not all(math.isfinite(value) for value in values):
                raise RuntimeError("embedding response contains non-finite values")
            embeddings.append(values)
        if len(embeddings) != len(texts):
            raise RuntimeError(f"embedding response count mismatch: expected {len(texts)}, got {len(embeddings)}")
        return embeddings

    def _hash_embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        for token in tokenize_for_embedding(text):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            return vector
        return [value / norm for value in vector]


@dataclass(frozen=True)
class VectorSearchResult:
    record_id: str
    text: str
    metadata: dict[str, Any]
    score: float


class JsonVectorIndex:
    def __init__(self, path: Path, embedding_model: EmbeddingModel):
        self.path = path
        self.embedding_model = embedding_model

    def build(self, records: Iterable[dict[str, Any]]) -> int:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        count = 0
        with self.path.open("w", encoding="utf-8") as handle:
            for record in records:
                text = str(record["text"])
                embedding = self.embedding_model.encode(text)
                stored = {
                    "id": str(record["id"]),
                    "text": text,
                    "metadata": record.get("metadata", {}),
                    "embedding": embedding,
                }
                handle.write(json.dumps(stored, ensure_ascii=False) + "\n")
                count += 1
        return count

    def search(
        self,
        query: str,
        top_k: int = 5,
        where: dict[str, Any] | None = None,
    ) -> list[VectorSearchResult]:
        query_embedding = self.embedding_model.encode(query)
        results: list[VectorSearchResult] = []
        for record in self._iter_records():
            metadata = record.get("metadata", {})
            if where and any(metadata.get(key) != value for key, value in where.items() if value):
                continue
            score = cosine_similarity(query_embedding, record.get("embedding", []))
            results.append(
                VectorSearchResult(
                    record_id=record["id"],
                    text=record["text"],
                    metadata=metadata,
                    score=score,
                )
            )
        results.sort(key=lambda item: (-item.score, item.record_id))
        return results[:top_k]

    def _iter_records(self) -> Iterable[dict[str, Any]]:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    yield json.loads(line)


class ChromaVectorIndex:
    def __init__(self, persist_dir: Path, collection_name: str, embedding_model: EmbeddingModel):
        self.persist_dir = persist_dir
        self.collection_name = collection_name
        self.embedding_model = embedding_model
        try:
            import chromadb  # type: ignore
        except Exception as exc:
            raise RuntimeError("chromadb is not installed; use JSTYLE_VECTOR_BACKEND=json") from exc
        self._client = chromadb.PersistentClient(path=str(persist_dir))
        self._collection = self._client.get_or_create_collection(collection_name)

    def build(self, records: Iterable[dict[str, Any]]) -> int:
        ids: list[str] = []
        docs: list[str] = []
        metadatas: list[dict[str, Any]] = []
        embeddings: list[list[float]] = []
        for record in records:
            ids.append(str(record["id"]))
            text = str(record["text"])
            docs.append(text)
            metadatas.append(_flatten_metadata(record.get("metadata", {})))
            embeddings.append(self.embedding_model.encode(text))
        if ids:
            self._collection.upsert(ids=ids, documents=docs, metadatas=metadatas, embeddings=embeddings)
        return len(ids)

    def search(
        self,
        query: str,
        top_k: int = 5,
        where: dict[str, Any] | None = None,
    ) -> list[VectorSearchResult]:
        where_clause = {key: value for key, value in (where or {}).items() if value}
        response = self._collection.query(
            query_embeddings=[self.embedding_model.encode(query)],
            n_results=top_k,
            where=where_clause or None,
        )
        results: list[VectorSearchResult] = []
        ids = response.get("ids", [[]])[0]
        docs = response.get("documents", [[]])[0]
        metadatas = response.get("metadatas", [[]])[0]
        distances = response.get("distances", [[]])[0]
        for record_id, doc, metadata, distance in zip(ids, docs, metadatas, distances):
            score = 1.0 - float(distance)
            results.append(VectorSearchResult(str(record_id), doc or "", metadata or {}, score))
        results.sort(key=lambda item: (-item.score, item.record_id))
        return results


def _flatten_metadata(metadata: dict[str, Any]) -> dict[str, str | int | float | bool]:
    flattened: dict[str, str | int | float | bool] = {}
    for key, value in metadata.items():
        if isinstance(value, (str, int, float, bool)):
            flattened[key] = value
        elif value is not None:
            flattened[key] = json.dumps(value, ensure_ascii=False)
    return flattened


def _strip_openai_embedding_prefix(model_name: str) -> str | None:
    for prefix in ("openai:", "openai-compatible:", "api:"):
        if model_name.startswith(prefix):
            return model_name[len(prefix) :].strip()
    return None


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"embedding request failed: {exc}") from exc


def make_embedding_model(model_name: str | None = None, allow_hash_fallback: bool | None = None) -> EmbeddingModel:
    model = model_name or os.getenv(
        "JSTYLE_EMBEDDING_MODEL",
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    )
    allow = allow_hash_fallback
    if allow is None:
        allow = os.getenv("JSTYLE_ALLOW_HASH_EMBEDDINGS", "1") != "0"
    return EmbeddingModel(
        model,
        allow_hash_fallback=allow,
        openai_base_url=os.getenv("JSTYLE_EMBEDDING_BASE_URL", ""),
        openai_api_key=os.getenv("JSTYLE_EMBEDDING_API_KEY", ""),
    )


def make_vector_index(
    backend: str,
    json_path: Path,
    chroma_dir: Path,
    collection_name: str,
    embedding_model: EmbeddingModel,
) -> JsonVectorIndex | ChromaVectorIndex:
    if backend == "chroma":
        return ChromaVectorIndex(chroma_dir, collection_name, embedding_model)
    return JsonVectorIndex(json_path, embedding_model)
