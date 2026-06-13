from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Optional

import typer

from jstyle_rag.config import ensure_directories, get_config
from jstyle_rag.generation.report_pipeline import generate_report as run_generate_report
from jstyle_rag.sources.source_index import build_source_index as run_build_source_index
from jstyle_rag.sources.source_ingest import ingest_sources as run_ingest_sources
from jstyle_rag.sources.source_metadata import (
    VALID_AUTHORITY_LEVELS,
    VALID_CITATION_ROLES,
    VALID_SOURCE_TYPES,
    classify_source_files as run_classify_source_files,
    resolve_source_path,
    write_sidecar_metadata,
)
from jstyle_rag.style.style_extractor import append_style_profile_from_file, extract_style_profiles_from_dir
from jstyle_rag.style.style_index import (
    build_style_indexes as run_build_style_indexes,
    default_profiles_path,
)
from jstyle_rag.style.style_seed_profiles import seed_style_profiles as run_seed_style_profiles


app = typer.Typer(help="Local Japanese Report Style RAG CLI.")


@app.command("ingest-style")
def ingest_style() -> None:
    cfg = get_config()
    ensure_directories(cfg)
    profiles = extract_style_profiles_from_dir(cfg.style_raw_dir, default_profiles_path(cfg))
    typer.echo(f"Extracted {len(profiles)} style profiles -> {default_profiles_path(cfg)}")


@app.command("build-style-index")
def build_style_index() -> None:
    cfg = get_config()
    ensure_directories(cfg)
    counts = run_build_style_indexes(cfg)
    typer.echo(json.dumps(counts, ensure_ascii=False, indent=2))


@app.command("seed-style-profiles")
def seed_style_profiles(
    overwrite: bool = typer.Option(False, "--overwrite/--append", help="Overwrite existing profiles instead of appending missing seeds."),
) -> None:
    cfg = get_config()
    ensure_directories(cfg)
    path = run_seed_style_profiles(cfg, overwrite=overwrite)
    typer.echo(f"Seeded abstract style profiles -> {path}")


@app.command("add-style-sample")
def add_style_sample(
    style_file: Path = typer.Argument(..., help="Authorized local report/sample file to use for abstract style only."),
    raw_name: Optional[Path] = typer.Option(None, "--raw-name", help="Optional relative name under data/style_corpus/raw."),
) -> None:
    cfg = get_config()
    ensure_directories(cfg)
    source = style_file.expanduser().resolve()
    if not source.exists():
        raise typer.BadParameter(f"style file does not exist: {source}")
    relative = raw_name or Path("user_provided") / _anonymized_style_name(source)
    if relative.is_absolute() or ".." in relative.parts:
        raise typer.BadParameter("--raw-name must be a safe relative path")
    target = cfg.style_raw_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source != target.resolve():
        shutil.copy2(source, target)
    profile = append_style_profile_from_file(
        target,
        default_profiles_path(cfg),
        source_file=str(target.relative_to(cfg.style_raw_dir)),
    )
    typer.echo(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2))


@app.command("ingest-sources")
def ingest_sources() -> None:
    cfg = get_config()
    ensure_directories(cfg)
    chunks = run_ingest_sources(cfg)
    typer.echo(f"Ingested {len(chunks)} source chunks -> {cfg.source_processed_dir}")


@app.command("build-source-index")
def build_source_index() -> None:
    cfg = get_config()
    ensure_directories(cfg)
    count = run_build_source_index(cfg)
    typer.echo(f"Indexed {count} source chunks -> {cfg.source_index_dir}")


@app.command("classify-sources")
def classify_sources(json_output: bool = typer.Option(False, "--json", help="Emit JSON instead of a table.")) -> None:
    cfg = get_config()
    ensure_directories(cfg)
    rows = run_classify_source_files(cfg.source_raw_dir)
    if json_output:
        typer.echo(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        typer.echo(f"No source files found under {cfg.source_raw_dir}")
        return
    for row in rows:
        typer.echo(
            "\t".join(
                [
                    row["source_file"],
                    row["source_type"],
                    row["authority_level"],
                    row["citation_role"],
                    f"sidecar={row['has_sidecar']}",
                ]
            )
        )


@app.command("write-source-meta")
def write_source_meta(
    source_file: Path = typer.Argument(..., help="Source file path, relative to data/source_corpus/raw unless absolute."),
    source_type: str = typer.Option(..., "--source-type", help=f"One of: {', '.join(sorted(VALID_SOURCE_TYPES))}"),
    authority_level: str = typer.Option(
        ...,
        "--authority-level",
        help=f"One of: {', '.join(sorted(VALID_AUTHORITY_LEVELS))}",
    ),
    citation_role: str = typer.Option(..., "--citation-role", help=f"One of: {', '.join(sorted(VALID_CITATION_ROLES))}"),
) -> None:
    cfg = get_config()
    ensure_directories(cfg)
    path = resolve_source_path(cfg.source_raw_dir, source_file)
    if not path.exists():
        raise typer.BadParameter(f"source file does not exist: {path}")
    try:
        sidecar = write_sidecar_metadata(path, source_type, authority_level, citation_role)
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc
    typer.echo(str(sidecar))


@app.command("generate")
def generate(
    topic: str = typer.Option(..., "--topic", help="Japanese report topic."),
    word_count: int = typer.Option(1600, "--word-count", help="Target Japanese character count."),
    discipline: str = typer.Option("general", "--discipline", help="Discipline filter."),
    target_style: str = typer.Option("undergraduate_report", "--target-style", help="Target report style."),
    requirements: str = typer.Option("", "--requirements", help="Assignment requirements."),
    user_point: Optional[list[str]] = typer.Option(None, "--user-point", help="User viewpoint. Repeatable."),
    save: bool = typer.Option(True, "--save/--no-save", help="Save JSON output under data/outputs."),
    show_prompt: bool = typer.Option(False, "--show-prompt", help="Include the internal prompt in CLI output."),
) -> None:
    result = run_generate_report(
        topic=topic,
        word_count=word_count,
        discipline=discipline,
        target_style=target_style,
        requirements=requirements,
        user_points=user_point or [],
        save=save,
    )
    if not show_prompt:
        result.pop("prompt", None)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2))


@app.command("serve")
def serve(
    host: Optional[str] = typer.Option(None, "--host"),
    port: Optional[int] = typer.Option(None, "--port"),
    reload: bool = typer.Option(False, "--reload/--no-reload"),
) -> None:
    import uvicorn

    cfg = get_config()
    uvicorn.run(
        "jstyle_rag.api.server:app",
        host=host or cfg.api_host,
        port=port or cfg.api_port,
        reload=reload,
    )


def _anonymized_style_name(path: Path) -> str:
    digest = hashlib.sha1(path.read_bytes()).hexdigest()[:10]
    suffix = path.suffix.lower() or ".txt"
    return f"user_report_{digest}{suffix}"


def main() -> None:
    app()


if __name__ == "__main__":
    main()
