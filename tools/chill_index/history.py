"""Historial de ejecuciones: una línea por corrida, haya o no datos nuevos.

El defecto que corrige: el consumidor sólo escribía historial cuando cambiaba el
hash, así que cinco días sin novedades quedaron como cinco días de silencio
absoluto — indistinguibles de «no pasó nada».

Acá **toda** corrida deja registro: con serie nueva, con serie repetida, con la
fuente caída o con el contenido inválido.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

#: Cuántas corridas se conservan en el archivo público. El histórico completo
#: vive en los commits del repositorio, que son inmutables.
MAX_ENTRIES = 500


def append_run(path: Path, entry: dict[str, Any], *, max_entries: int = MAX_ENTRIES) -> int:
    """Agrega una corrida al historial JSONL y devuelve cuántas quedaron."""

    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if path.exists():
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    lines.append(json.dumps(entry, ensure_ascii=False, sort_keys=True))
    if len(lines) > max_entries:
        lines = lines[-max_entries:]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def read_runs(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    salida: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                salida.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return salida


def last_valid_forecast(runs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Última corrida que llegó a publicar al menos un mapa con categoría."""

    for run in reversed(runs):
        if int(run.get("maps_valid") or 0) > 0 and run.get("forecast_run_date"):
            return run
    return None


def build_entry(
    *,
    run_id: str,
    trigger: str,
    started_at: str,
    finished_at: str,
    technical_result: str,
    source_result: str,
    publication_result: str,
    forecast_run_date: str | None,
    new_series: bool,
    maps_requested: int,
    maps_downloaded: int,
    maps_valid: int,
    maps_undefined: int,
    maps_rejected: int,
    output_hash: str | None,
    previous_output_hash: str | None,
    error_code: str | None = None,
    error_detail: str | None = None,
    workflow_run_url: str | None = None,
    commit_sha: str | None = None,
) -> dict[str, Any]:
    """Entrada del historial con los campos exigidos por la operación."""

    return {
        "run_id": run_id,
        "trigger": trigger,
        "started_at": started_at,
        "finished_at": finished_at,
        "technical_result": technical_result,
        "source_result": source_result,
        "publication_result": publication_result,
        "forecast_run_date": forecast_run_date,
        "new_series": new_series,
        "maps_requested": maps_requested,
        "maps_downloaded": maps_downloaded,
        "maps_valid": maps_valid,
        "maps_undefined": maps_undefined,
        "maps_rejected": maps_rejected,
        "output_hash": output_hash,
        "previous_output_hash": previous_output_hash,
        "error_code": error_code,
        "error_detail": error_detail,
        "workflow_run_url": workflow_run_url,
        "commit_sha": commit_sha,
    }
