"""Orquestación del pipeline. Punto de entrada del workflow de GitHub Actions.

Flujo: descubrir fechas → descargar → validar contenido → verificar vigencia →
clasificar → construir contrato → validar esquema e invariantes → publicar
atómicamente → registrar la corrida.

Nunca inventa un pronóstico. Si INIA publica grillas vacías, el resultado
correcto es una serie de días «sin datos» y estado
``SIN_PRONOSTICO_CONFIABLE``, con la corrida terminando de forma controlada.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from . import contract, freshness, history, http_source, imaging, publisher, settings
from .classifier import classify

MODEL_LABEL = "WRF (INIA-GRAS), resolución completa 780x650"


def _iso(value: datetime) -> str:
    return value.isoformat()


def run(
    *,
    output: Path,
    evidence_root: Path,
    history_path: Path,
    trigger: str,
    today: date | None = None,
    now: datetime | None = None,
    session: Any | None = None,
    workflow_run_url: str | None = None,
    skip_mini: bool = False,
) -> dict[str, Any]:
    """Ejecuta una corrida completa y devuelve un resumen para el log."""

    tz = ZoneInfo(settings.TIMEZONE)
    started = now or datetime.now(UTC)
    hoy = today or started.astimezone(tz).date()
    run_id = uuid.uuid4().hex[:12]
    calibration = settings.load_calibration()

    fechas = [hoy + timedelta(days=i) for i in range(settings.HORIZON_DAYS)]
    mapas: list[dict[str, Any]] = []
    http_log: list[dict[str, Any]] = []
    descargados = 0
    validos = 0
    indefinidos = 0
    rechazados = 0
    fetch_failed_all = True
    forecast_run_date: str | None = None
    edad_fuente: float | None = None

    for indice, dia in enumerate(fechas):
        url = http_source.wrf_url(dia)
        descarga = http_source.fetch(url, session=session, now=started)
        http_log.append(descarga.evidence())
        etiqueta = dia.isoformat()

        if not descarga.ok:
            if descarga.http_status == 404:
                motivo, estado = "MAP_NOT_PUBLISHED", "NOT_FETCHED"
            else:
                motivo, estado = "SOURCE_UNAVAILABLE", "NOT_FETCHED"
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason=motivo,
                    reason_detail=descarga.error,
                    validation_status=estado,
                    http_status=descarga.http_status,
                )
            )
            continue

        fetch_failed_all = False
        descargados += 1
        assert descarga.body is not None and descarga.sha256 is not None

        revision = imaging.check_wrf(descarga.body, calibration)
        evidencia = publisher.store_evidence(
            evidence_root, day=etiqueta, sha256=descarga.sha256, content=descarga.body
        )
        vigencia = freshness.evaluate_source(descarga.last_modified_utc(), now=started)

        if revision.status == imaging.NO_DATA:
            indefinidos += 1
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason="WRF_UNDEFINED_GRID",
                    reason_detail=revision.reason,
                    validation_status=imaging.NO_DATA,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                )
            )
            continue

        if revision.status != imaging.VALID:
            rechazados += 1
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason="MAP_REJECTED",
                    reason_detail=revision.reason,
                    validation_status=revision.status,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                )
            )
            continue

        if not vigencia.verified:
            rechazados += 1
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason="SOURCE_DATE_UNVERIFIED",
                    reason_detail=(
                        "El mapa tiene datos pero su Last-Modified no permite verificar "
                        "que la corrida sea vigente"
                    ),
                    validation_status=imaging.VALID,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                )
            )
            continue

        if freshness.horizon_expired(dia, today=hoy):
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason="FORECAST_EXPIRED",
                    reason_detail="La fecha del pronóstico ya pasó",
                    validation_status=imaging.VALID,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                )
            )
            continue

        assert revision.image is not None
        clasificacion = classify(
            revision.image,
            calibration,
            lat=float(settings.LOCATION["latitude"]),
            lon=float(settings.LOCATION["longitude"]),
        )
        if clasificacion.category is None:
            rechazados += 1
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    reason="MAP_REJECTED",
                    reason_detail=clasificacion.reason
                    or "La categoría no pudo determinarse con la paleta calibrada",
                    validation_status=imaging.VALID,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                )
            )
            continue

        validos += 1
        if forecast_run_date is None:
            momento = descarga.last_modified_utc()
            if momento is not None:
                forecast_run_date = momento.astimezone(tz).date().isoformat()
                edad_fuente = vigencia.source_age_hours
        mapas.append(
            contract.risk_map(
                forecast_day=indice,
                valid_date=etiqueta,
                source_url=url,
                sha256=descarga.sha256,
                last_modified=descarga.last_modified,
                source_age_hours=vigencia.source_age_hours,
                http_status=descarga.http_status,
                category=clasificacion.category,
                confidence=clasificacion.confidence,
                evidence_path=evidencia,
            )
        )

    diagnostico_mini = _diagnose_mini(session=session, now=started, skip=skip_mini)

    corridas = history.read_runs(history_path)
    ultima_valida = history.last_valid_forecast(corridas)
    ultima_fecha = ultima_valida.get("forecast_run_date") if ultima_valida else None
    if validos and forecast_run_date:
        ultima_fecha = forecast_run_date

    estado = contract.system_status(
        mapas, today_iso=hoy.isoformat(), fetch_failed=fetch_failed_all
    )
    finished = datetime.now(UTC)

    payload: dict[str, Any] = {
        "schema_version": settings.SCHEMA_VERSION,
        "pipeline_version": settings.PIPELINE_VERSION,
        "status": estado,
        "status_label": contract.STATUS_LABELS[estado],
        "status_detail": _status_detail(estado, indefinidos, len(fechas)),
        "source": settings.SOURCE_NAME,
        "source_page": settings.SOURCE_PAGE,
        "location": dict(settings.LOCATION),
        "timezone": settings.TIMEZONE,
        "run_started_at": _iso(started),
        "run_finished_at": _iso(finished),
        "run_trigger": trigger,
        "forecast_run_date": forecast_run_date,
        "freshness": {
            "covers_today": any(
                m["valid_date"] == hoy.isoformat() and m["display_status"] == "DISPONIBLE"
                for m in mapas
            ),
            "maps_valid": validos,
            "maps_total": len(mapas),
            "source_age_hours": edad_fuente,
            "last_valid_forecast_run_date": ultima_fecha,
            "last_valid_age_days": freshness.carry_forward_age(ultima_fecha, today=hoy),
        },
        "model": MODEL_LABEL,
        "maps": mapas,
        "diagnostics": {
            "wrf_mini": diagnostico_mini,
            "http": http_log,
            "notes": [
                "WRF_mini se descarga sólo como diagnóstico: no publica categorías "
                "productivas mientras no exista una calibración validada.",
                "Una fecha sin mapa WRF completo válido y vigente se publica como "
                "NO_DETERMINADO / SIN_DATOS, nunca como SIN_RIESGO.",
            ],
        },
    }

    contract.validate(payload, today_iso=hoy.isoformat())

    anterior = publisher.read_previous(output)
    hash_anterior = publisher.payload_hash(anterior) if anterior else None
    hash_nuevo = publisher.payload_hash(payload)
    cambio = hash_anterior != hash_nuevo

    if cambio:
        publisher.write_atomic(output, payload)
        resultado_publicacion = "PUBLICADO"
    else:
        resultado_publicacion = "SIN_CAMBIOS"

    entrada = history.build_entry(
        run_id=run_id,
        trigger=trigger,
        started_at=_iso(started),
        finished_at=_iso(finished),
        technical_result="OK",
        source_result=estado,
        publication_result=resultado_publicacion,
        forecast_run_date=forecast_run_date,
        new_series=bool(cambio and validos),
        maps_requested=len(fechas),
        maps_downloaded=descargados,
        maps_valid=validos,
        maps_undefined=indefinidos,
        maps_rejected=rechazados,
        output_hash=hash_nuevo,
        previous_output_hash=hash_anterior,
        error_code=None if estado != "FUENTE_NO_DISPONIBLE" else "SOURCE_UNAVAILABLE",
        error_detail=None,
        workflow_run_url=workflow_run_url,
    )
    history.append_run(history_path, entrada)

    return {
        "run_id": run_id,
        "status": estado,
        "publication": resultado_publicacion,
        "maps_valid": validos,
        "maps_undefined": indefinidos,
        "maps_rejected": rechazados,
        "maps_downloaded": descargados,
        "content_changed": cambio,
        "output_hash": hash_nuevo,
        "days": [
            {"date": m["valid_date"], "risk": m["risk_category"], "reason": m["reason"]}
            for m in mapas
        ],
    }


def _status_detail(estado: str, indefinidos: int, total: int) -> str | None:
    if estado == "SIN_PRONOSTICO_CONFIABLE" and indefinidos:
        return (
            f"INIA publicó {indefinidos} de {total} mapas sin grilla utilizable "
            "(patrón 'Entire Grid Undefined')."
        )
    if estado == "FUENTE_NO_DISPONIBLE":
        return "No se pudo obtener ningún mapa de la fuente oficial."
    if estado == "DATOS_PARCIALES":
        return "Sólo algunas fechas del horizonte tienen un mapa válido y vigente."
    return None


def _diagnose_mini(*, session: Any, now: datetime, skip: bool) -> dict[str, Any]:
    """Observa las miniaturas. Evidencia y comparación: nunca fuente productiva."""

    politica = (
        "WRF_mini NO se usa como fuente autónoma de categorías productivas. "
        "Se observa para diagnóstico, comparación y alerta de disponibilidad."
    )
    if skip:
        return {"policy": politica, "run_date_hint": None, "observations": []}

    observaciones: list[dict[str, Any]] = []
    pista: str | None = None
    for indice in range(settings.HORIZON_DAYS):
        url = http_source.mini_url(indice)
        descarga = http_source.fetch(url, session=session, now=now)
        registro = descarga.evidence()
        registro["index"] = indice
        if indice == 0 and descarga.last_modified_utc() is not None:
            momento = descarga.last_modified_utc()
            assert momento is not None
            pista = momento.astimezone(ZoneInfo(settings.TIMEZONE)).date().isoformat()
        observaciones.append(registro)
    return {"policy": politica, "run_date_hint": pista, "observations": observaciones}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pipeline Chill Index CICOMA")
    parser.add_argument("--output", default="data/chill_index.json")
    parser.add_argument("--evidence", default="evidence")
    parser.add_argument("--history", default="data/chill_history.jsonl")
    parser.add_argument("--trigger", default="manual")
    parser.add_argument("--workflow-run-url", default=None)
    parser.add_argument("--skip-mini", action="store_true")
    args = parser.parse_args(argv)

    resumen = run(
        output=Path(args.output),
        evidence_root=Path(args.evidence),
        history_path=Path(args.history),
        trigger=args.trigger,
        workflow_run_url=args.workflow_run_url,
        skip_mini=args.skip_mini,
    )
    print(json.dumps(resumen, ensure_ascii=False, indent=2))
    print()
    print(f"Estado del sistema : {resumen['status']}")
    print(f"Publicación        : {resumen['publication']}")
    for dia in resumen["days"]:
        detalle = dia["risk"] if dia["risk"] != "NO_DETERMINADO" else f"SIN DATOS ({dia['reason']})"
        print(f"  {dia['date']}  {detalle}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
