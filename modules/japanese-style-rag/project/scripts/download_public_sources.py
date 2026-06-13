from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "source_corpus" / "public_sources.json"
RAW_DIR = ROOT / "data" / "source_corpus" / "raw"

SIDECAR_KEYS = {
    "source_type",
    "authority_level",
    "citation_role",
    "title",
    "source_url",
    "landing_url",
    "published_date",
    "publisher",
    "license_note",
}


def main() -> None:
    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    downloaded = []
    for entry in entries:
        target = RAW_DIR / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.stat().st_size == 0:
            _download(entry["url"], target)
        _write_sidecar(entry, target)
        downloaded.append({"path": str(target.relative_to(ROOT)), "bytes": target.stat().st_size})
    print(json.dumps({"downloaded": downloaded}, ensure_ascii=False, indent=2))


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "japanese-report-style-rag/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            target.write_bytes(response.read())
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc


def _write_sidecar(entry: dict, target: Path) -> None:
    sidecar = target.with_name(f"{target.name}.meta.json")
    data = {key: entry[key] for key in SIDECAR_KEYS if key in entry}
    data["source_url"] = entry["url"]
    sidecar.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
