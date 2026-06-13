from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def find_project_root() -> Path:
    env_root = os.getenv("JSTYLE_RAG_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()

    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if (candidate / "pyproject.toml").exists() and (candidate / "data").exists():
            return candidate

    here = Path(__file__).resolve()
    return here.parents[2]


@dataclass(frozen=True)
class AppConfig:
    project_root: Path
    data_dir: Path
    style_raw_dir: Path
    style_profiles_dir: Path
    style_index_dir: Path
    source_raw_dir: Path
    source_processed_dir: Path
    source_index_dir: Path
    outputs_dir: Path
    vector_backend: str
    embedding_model: str
    embedding_base_url: str
    embedding_api_key: str
    allow_hash_embeddings: bool
    llm_provider: str
    ollama_base_url: str
    ollama_model: str
    openai_base_url: str
    openai_api_key: str
    openai_model: str
    api_host: str
    api_port: int


def get_config() -> AppConfig:
    root = find_project_root()
    data_dir = root / "data"
    return AppConfig(
        project_root=root,
        data_dir=data_dir,
        style_raw_dir=data_dir / "style_corpus" / "raw",
        style_profiles_dir=data_dir / "style_corpus" / "profiles",
        style_index_dir=data_dir / "style_corpus" / "index",
        source_raw_dir=data_dir / "source_corpus" / "raw",
        source_processed_dir=data_dir / "source_corpus" / "processed",
        source_index_dir=data_dir / "source_corpus" / "index",
        outputs_dir=data_dir / "outputs",
        vector_backend=os.getenv("JSTYLE_VECTOR_BACKEND", "json").strip().lower(),
        embedding_model=os.getenv(
            "JSTYLE_EMBEDDING_MODEL",
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        ),
        embedding_base_url=os.getenv("JSTYLE_EMBEDDING_BASE_URL", "http://127.0.0.1:8001/v1").rstrip("/"),
        embedding_api_key=os.getenv("JSTYLE_EMBEDDING_API_KEY", ""),
        allow_hash_embeddings=os.getenv("JSTYLE_ALLOW_HASH_EMBEDDINGS", "1") != "0",
        llm_provider=os.getenv("JSTYLE_LLM_PROVIDER", "offline").strip().lower(),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        openai_base_url=os.getenv("OPENAI_BASE_URL", "http://localhost:8000/v1").rstrip("/"),
        openai_api_key=os.getenv("OPENAI_API_KEY", ""),
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        api_host=os.getenv("JSTYLE_API_HOST", "127.0.0.1"),
        api_port=int(os.getenv("JSTYLE_API_PORT", "8008")),
    )


def ensure_directories(config: AppConfig | None = None) -> None:
    cfg = config or get_config()
    for path in (
        cfg.style_raw_dir,
        cfg.style_profiles_dir,
        cfg.style_index_dir,
        cfg.source_raw_dir,
        cfg.source_processed_dir,
        cfg.source_index_dir,
        cfg.outputs_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)
