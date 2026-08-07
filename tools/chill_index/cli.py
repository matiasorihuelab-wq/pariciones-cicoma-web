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

from . import batches, contract, freshness, history, http_source, imaging, publisher, settings
from .classifier import classify, classify_mini

MODEL_LABEL = "WRF (INIA-GRAS), resolución completa 780x650"


def _iso(value: datetime) -> str:
    return value.isoformat()



def _download_failure(descarga: Any) -> tuple[str, str]:
    """Traduce un fallo de descarga a (disponibilidad, motivo).

    Un 404 es la respuesta definitiva de INIA cuando **todavía no publicó** el
    mapa de esa fecha: la fuente contestó bien y no hay dato. Cualquier otra
    cosa —timeout, 403, 429, 5xx, DNS— es una falla técnica.
    """

    estado = descarga.http_status
    if estado == 404:
        return "SIN_DATOS", "MAP_NOT_PUBLISHED"
    if estado == 403:
        return "ERROR", "SOURCE_HTTP_403"
    if estado == 429:
        return "ERROR", "SOURCE_HTTP_429"
    if estado is not None and 500 <= estado < 600:
        return "ERROR", "SOURCE_HTTP_5XX"
    if estado is not None and estado != 200:
        return "ERROR", "SOURCE_HTTP_404" if estado == 404 else "SOURCE_HTTP_5XX"
    detalle = (descarga.error or "").lower()
    if "timeout" in detalle or "timedout" in detalle:
        return "ERROR", "SOURCE_TIMEOUT"
    return "ERROR", "SOURCE_TIMEOUT"


def _observe_mini_batch(
    *, session: Any, now: datetime, batches_path: Path, skip: bool
) -> tuple[batches.MiniBatch | None, dict[str, batches.MiniBatch], list[dict[str, Any]]]:
    """Descarga los cinco minis, identifica el lote y persiste su fecha base.

    El lote se reconoce por el hash de sus cinco cuerpos. Si ya se conocia, se
    reutiliza su ``batch_run_date``: que INIA vuelva a servir un lote viejo no
    lo convierte en la corrida de hoy.
    """

    if skip:
        return None, batches.read_batches(batches_path), []
    miembros: dict[str, dict[str, Any]] = {}
    observaciones: list[dict[str, Any]] = []
    for indice in range(settings.HORIZON_DAYS):
        url = http_source.mini_url(indice)
        descarga = http_source.fetch(url, session=session, now=now)
        registro = descarga.evidence()
        registro["index"] = indice
        observaciones.append(registro)
        if not descarga.ok or descarga.sha256 is None:
            continue
        momento = descarga.last_modified_utc()
        miembros[str(indice)] = {
            "sha256": descarga.sha256,
            "url": url,
            "last_modified": descarga.last_modified,
            "last_modified_utc": momento.isoformat() if momento else None,
            "bytes": len(descarga.body or b""),
        }
    if not miembros:
        return None, batches.read_batches(batches_path), observaciones
    lote, lotes = batches.observe(batches_path, miembros, now=now)
    return lote, lotes, observaciones


def _try_mini(
    *,
    valid_date: date,
    forecast_day: int,
    lotes: dict[str, batches.MiniBatch],
    session: Any,
    now: datetime,
    evidence_root: Path,
    motivo_wrf: str,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Resuelve una fecha con el WRF_mini. ``None`` si ningun lote la rescata.

    Se llama SOLO cuando el WRF completo no fue interpretable. Recorre los
    lotes que predicen esa fecha del mas reciente al mas antiguo: el pronostico
    mas nuevo manda, y si resulta invalido se cae al anterior. Nunca toma un
    mini de otra fecha ni de un lote sin fecha base.
    """

    intentos: list[dict[str, Any]] = []
    for lote, indice in batches.forecast_for(valid_date, lotes):
        url = http_source.mini_url(indice)
        descarga = http_source.fetch(url, session=session, now=now)
        if not descarga.ok or descarga.body is None or descarga.sha256 is None:
            intentos.append({"batch_id": lote.batch_id, "resultado": "no se descargo"})
            continue
        # El cuerpo servido tiene que ser el del lote, y tenemos que SABER cual
        # es el suyo. Las URLs Min_N sirven siempre el juego vigente: un lote del
        # que no conocemos los hashes no puede reclamar una fecha, porque no hay
        # forma de comprobar que lo que INIA esta sirviendo sea suyo. Sin esta
        # verificacion, un lote sembrado por auditoria —o cualquier lote viejo—
        # le pondria SU fecha a los pixeles de otro juego.
        esperado = (lote.members.get(str(indice)) or {}).get("sha256")
        if not esperado:
            intentos.append(
                {"batch_id": lote.batch_id, "resultado": "no se conocen los cuerpos de ese lote"}
            )
            continue
        if esperado != descarga.sha256:
            intentos.append(
                {"batch_id": lote.batch_id, "resultado": "el slot ya no sirve el cuerpo del lote"}
            )
            continue
        revision = imaging.check_wrf_mini(descarga.body, settings.load_mini_calibration())
        if revision.status != imaging.VALID or revision.image is None:
            intentos.append({"batch_id": lote.batch_id, "resultado": f"mini {revision.status}"})
            continue
        clasificacion = classify_mini(
            revision.image,
            settings.load_mini_calibration(),
            lat=float(settings.LOCATION["latitude"]),
            lon=float(settings.LOCATION["longitude"]),
        )
        if clasificacion.category is None:
            intentos.append({"batch_id": lote.batch_id, "resultado": clasificacion.reason})
            continue
        evidencia = publisher.store_evidence(
            evidence_root, day=valid_date.isoformat(), sha256=descarga.sha256, content=descarga.body
        )
        vigencia = freshness.evaluate_source(descarga.last_modified_utc(), now=now)
        mapa = contract.risk_map(
            forecast_day=forecast_day,
            valid_date=valid_date.isoformat(),
            source_url=url,
            sha256=descarga.sha256,
            last_modified=descarga.last_modified,
            source_age_hours=vigencia.source_age_hours,
            http_status=descarga.http_status,
            category=clasificacion.category,
            confidence=clasificacion.confidence,
            evidence_path=evidencia,
            checked_at=descarga.requested_at,
        )
        # La trazabilidad NO va en el contrato publico
        # (additionalProperties:false): queda en el historial interno.
        traza = {
            "valid_date": valid_date.isoformat(),
            "source_product": "WRF_MINI",
            "source_url": url,
            "source_sha256": descarga.sha256,
            "source_last_modified": descarga.last_modified,
            "mini_index": indice,
            "batch_id": lote.batch_id,
            "batch_run_date": lote.batch_run_date,
            "fallback_reason": motivo_wrf,
            "category": clasificacion.category,
            "confidence": clasificacion.confidence,
            "votes": clasificacion.votes,
            "detail": clasificacion.reason,
            "rejected_batches": intentos,
            "checked_at": descarga.requested_at,
        }
        return mapa, traza
    return None


def run(
    *,
    output: Path,
    evidence_root: Path,
    history_path: Path,
    batches_path: Path,
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

    # Identidad del juego de minis: se resuelve una vez por corrida y su
    # fecha base se persiste, para que un lote viejo no se relea como el de hoy.
    lote_actual, lotes_mini, observaciones_mini = _observe_mini_batch(
        session=session, now=started, batches_path=batches_path, skip=skip_mini
    )

    fechas = [hoy + timedelta(days=i) for i in range(settings.HORIZON_DAYS)]
    mapas: list[dict[str, Any]] = []
    #: Qué producto resolvió cada fecha. Interno: no viaja en el contrato.
    trazabilidad: list[dict[str, Any]] = []
    http_log: list[dict[str, Any]] = []
    descargados = 0
    validos = 0
    #: Fechas que resolvió el respaldo. Se cuentan aparte porque un rescate del
    #: mini NO establece una corrida nueva del WRF: da una categoría publicable,
    #: no una `forecast_run_date`.
    rescatados = 0
    indefinidos = 0
    rechazados = 0
    errores = 0
    forecast_run_date: str | None = None
    edad_fuente: float | None = None
    #: Ultimo instante en que INIA entrego un cuerpo descargable. Es «se
    #: miro la fuente», no «hay pronostico nuevo»: los dos conceptos se
    #: publican por separado para no volver a decir «actualizado hoy»
    #: cuando lo unico de hoy fue la verificacion.
    ultima_lectura: str | None = None

    def _sin_wrf(mapa: dict[str, Any], *, indice: int, dia: date, motivo: str) -> dict[str, Any]:
        """El WRF no sirvió: se intenta el mini de ESA fecha antes de rendirse."""

        nonlocal rescatados
        if skip_mini:
            return mapa
        rescate = _try_mini(
            valid_date=dia,
            forecast_day=indice,
            lotes=lotes_mini,
            session=session,
            now=started,
            evidence_root=evidence_root,
            motivo_wrf=motivo,
        )
        if rescate is None:
            trazabilidad.append({
                "valid_date": dia.isoformat(),
                "source_product": None,
                "fallback_reason": motivo,
                "detail": "ni el WRF completo ni el WRF_mini de esa fecha fueron interpretables",
            })
            return mapa
        mapa_mini, traza = rescate
        trazabilidad.append(traza)
        rescatados += 1
        return mapa_mini

    for indice, dia in enumerate(fechas):
        url = http_source.wrf_url(dia)
        descarga = http_source.fetch(url, session=session, now=started)
        http_log.append(descarga.evidence())
        etiqueta = dia.isoformat()

        if not descarga.ok:
            disponibilidad, motivo = _download_failure(descarga)
            if disponibilidad == "ERROR":
                errores += 1
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status=disponibilidad,
                    reason_code=motivo,
                    reason_detail=descarga.error,
                    validation_status="NOT_FETCHED",
                    http_status=descarga.http_status,
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="el WRF completo no se pudo descargar",
                )
            )
            continue

        descargados += 1
        assert descarga.body is not None and descarga.sha256 is not None
        if ultima_lectura is None or descarga.requested_at > ultima_lectura:
            ultima_lectura = descarga.requested_at

        revision = imaging.check_wrf(descarga.body, calibration)
        evidencia = publisher.store_evidence(
            evidence_root, day=etiqueta, sha256=descarga.sha256, content=descarga.body
        )
        vigencia = freshness.evaluate_source(descarga.last_modified_utc(), now=started)

        if revision.status == imaging.NO_DATA:
            indefinidos += 1
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status="SIN_DATOS",
                    reason_code="WRF_UNDEFINED_GRID",
                    reason_detail=revision.reason,
                    validation_status=imaging.NO_DATA,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="WRF completo sin grilla utilizable (placeholder)",
                )
            )
            continue

        if revision.status != imaging.VALID:
            rechazados += 1
            errores += 1
            # Un PNG ilegible o de dimensiones inesperadas es una falla técnica,
            # no una fuente sin datos: la fuente entregó algo que no pudimos
            # procesar.
            motivo = (
                "INVALID_DIMENSIONS"
                if "Dimensiones" in revision.reason
                else "CORRUPT_IMAGE"
            )
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status="ERROR",
                    reason_code=motivo,
                    reason_detail=revision.reason,
                    validation_status=revision.status,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="el WRF completo no se pudo descargar",
                )
            )
            continue

        if not vigencia.verified:
            rechazados += 1
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status="SIN_DATOS",
                    reason_code="SOURCE_DATE_UNVERIFIED",
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
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="no se pudo verificar la vigencia del WRF completo",
                )
            )
            continue

        if freshness.horizon_expired(dia, today=hoy):
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status="SIN_DATOS",
                    reason_code="FORECAST_EXPIRED",
                    reason_detail="La fecha del pronóstico ya pasó",
                    validation_status=imaging.VALID,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="el WRF completo no fue interpretable",
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
            errores += 1
            mapas.append(
                _sin_wrf(
                contract.unavailable_map(
                    forecast_day=indice,
                    valid_date=etiqueta,
                    source_url=url,
                    availability_status="ERROR",
                    reason_code="CLASSIFICATION_ERROR",
                    reason_detail=clasificacion.reason
                    or "La categoría no pudo determinarse con la paleta calibrada",
                    validation_status=imaging.VALID,
                    sha256=descarga.sha256,
                    last_modified=descarga.last_modified,
                    source_age_hours=vigencia.source_age_hours,
                    http_status=descarga.http_status,
                    evidence_path=evidencia,
                    checked_at=descarga.requested_at,
                )
                ,
                    indice=indice,
                    dia=dia,
                    motivo="el WRF completo no pudo clasificarse",
                )
            )
            continue

        validos += 1
        if forecast_run_date is None:
            momento = descarga.last_modified_utc()
            if momento is not None:
                forecast_run_date = momento.astimezone(tz).date().isoformat()
                edad_fuente = vigencia.source_age_hours
        mapa_wrf = contract.risk_map(
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
            checked_at=descarga.requested_at,
        )
        trazabilidad.append({
            "valid_date": etiqueta,
            "source_product": "WRF",
            "source_url": url,
            "source_sha256": descarga.sha256,
            "source_last_modified": descarga.last_modified,
            "category": clasificacion.category,
            "confidence": clasificacion.confidence,
            "checked_at": descarga.requested_at,
        })
        mapas.append(mapa_wrf)

    diagnostico_mini = _diagnose_mini(
        lote=lote_actual, observaciones=observaciones_mini, skip=skip_mini
    )

    corridas = history.read_runs(history_path)
    ultima_valida = history.last_valid_forecast(corridas)
    ultima_fecha = ultima_valida.get("forecast_run_date") if ultima_valida else None
    if validos and forecast_run_date:
        # Nunca hacia atrás. `forecast_run_date` sale del Last-Modified del
        # PRIMER mapa válido, y cuál es el primero depende de qué fechas
        # sobrevivieron ese día: el 07/08 pasó de 06/08 a 05/08 y el tablero
        # saltó de «hace 1 día» a «hace 2 días» sin que INIA hubiera perdido
        # nada. Que hoy sólo sirvan mapas de una corrida más vieja no borra que
        # ayer hubo una más nueva. Las fechas ISO se comparan como texto.
        ultima_fecha = max(f for f in (ultima_fecha, forecast_run_date) if f)

    estado = contract.system_status(mapas, today_iso=hoy.isoformat())
    finished = datetime.now(UTC)

    payload: dict[str, Any] = {
        "schema_version": settings.SCHEMA_VERSION,
        "pipeline_version": settings.PIPELINE_VERSION,
        "status": estado,
        "status_label": contract.STATUS_LABELS[estado],
        "status_detail": _status_detail(estado, indefinidos, len(fechas), errores),
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
                m["valid_date"] == hoy.isoformat() and m["availability_status"] == "DISPONIBLE"
                for m in mapas
            ),
            "maps_valid": validos + rescatados,
            "maps_total": len(mapas),
            "source_age_hours": edad_fuente,
            "last_valid_forecast_run_date": ultima_fecha,
            "last_valid_age_days": freshness.carry_forward_age(ultima_fecha, today=hoy),
            "latest_source_seen": ultima_lectura,
            "latest_valid_forecast": ultima_fecha,
        },
        "model": MODEL_LABEL,
        "maps": mapas,
        "diagnostics": {
            "wrf_mini": diagnostico_mini,
            "http": http_log,
            "notes": [
                "El WRF completo es la fuente primaria. WRF_mini sólo se usa como "
                "respaldo de una fecha cuyo WRF completo no fue interpretable, con "
                "su propia calibración y regla precautoria.",
                "Cada miniatura se fecha por el lote al que pertenece "
                "(batch_run_date + índice), no por el día en que se la descarga.",
                "Una fecha que ningún producto pudo resolver se publica como "
                "NO_DETERMINADO / SIN_DATOS, nunca como SIN_RIESGO.",
            ],
        },
    }

    contract.validate(payload, today_iso=hoy.isoformat())

    anterior = publisher.read_previous(output)
    hash_anterior = publisher.payload_hash(anterior) if anterior else None
    hash_nuevo = publisher.payload_hash(payload)
    cambio = hash_anterior != hash_nuevo

    # No hace falta forzar un refresco periódico del sello de verificación: el
    # horizonte son cinco fechas contadas desde hoy, así que al cruzar la
    # medianoche los cinco `valid_date` cambian y el contrato se reescribe solo.
    # «Última verificación» no puede quedar más de un día atrasada.
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
        maps_valid=validos + rescatados,
        maps_undefined=indefinidos,
        maps_rejected=rechazados,
        maps_error=errores,
        output_hash=hash_nuevo,
        previous_output_hash=hash_anterior,
        error_code=next(
            (m["reason_code"] for m in mapas if m["availability_status"] == "ERROR"), None
        ),
        error_detail=next(
            (m["reason_detail"] for m in mapas if m["availability_status"] == "ERROR"), None
        ),
        workflow_run_url=workflow_run_url,
    )
    # Trazabilidad por fecha: qué producto la resolvió y por qué. Vive acá,
    # en el historial interno, y no en el contrato público.
    entrada["sources_by_date"] = trazabilidad
    entrada["mini_batch"] = (
        {
            "batch_id": lote_actual.batch_id,
            "batch_run_date": lote_actual.batch_run_date,
            "first_seen_at": lote_actual.first_seen_at,
            "last_seen_at": lote_actual.last_seen_at,
            "run_date_source": lote_actual.run_date_source,
        }
        if lote_actual is not None
        else None
    )
    history.append_run(history_path, entrada)

    return {
        "run_id": run_id,
        "status": estado,
        "publication": resultado_publicacion,
        "maps_valid": validos + rescatados,
        "maps_rescued_by_mini": rescatados,
        "maps_undefined": indefinidos,
        "maps_rejected": rechazados,
        "maps_error": errores,
        "maps_downloaded": descargados,
        "content_changed": cambio,
        "output_hash": hash_nuevo,
        "sources_by_date": trazabilidad,
        "days": [
            {
                "date": m["valid_date"],
                "risk": m["risk_category"],
                "availability": m["availability_status"],
                "reason": m["reason_code"],
            }
            for m in mapas
        ],
    }


def _status_detail(estado: str, indefinidos: int, total: int, errores: int) -> str | None:
    if estado == "SIN_PRONOSTICO_CONFIABLE" and indefinidos:
        return (
            f"INIA publicó {indefinidos} de {total} mapas sin grilla utilizable "
            "(patrón 'Entire Grid Undefined')."
        )
    if estado in ("ERROR_DE_FUENTE", "ERROR_DE_PIPELINE"):
        return f"Fallas técnicas en {errores} de {total} fechas del horizonte."
    if estado == "DATOS_PARCIALES_CON_ERRORES":
        return (
            f"Hay pronóstico para algunas fechas; {errores} de {total} fallaron "
            "por un problema técnico."
        )
    if estado == "DATOS_PARCIALES":
        return "Sólo algunas fechas del horizonte tienen un mapa válido y vigente."
    return None


def _diagnose_mini(
    *,
    lote: batches.MiniBatch | None,
    observaciones: list[dict[str, Any]],
    skip: bool,
) -> dict[str, Any]:
    """Identidad y estado del juego de miniaturas observado en esta corrida.

    No descarga nada: las cinco miniaturas ya se bajaron una sola vez al
    resolver la identidad del lote. Publica la fecha base del lote —que es lo
    que fecha sus cinco slots— y no una «pista» tomada del Last-Modified de
    Min_0, que era engañosa cuando INIA re-servía un lote viejo.
    """

    politica = (
        "WRF_mini es fuente de respaldo POR FECHA: sólo resuelve una fecha cuando "
        "el WRF completo de esa misma fecha no fue interpretable. Cada slot se "
        "fecha como batch_run_date + índice del lote al que pertenece, nunca como "
        "hoy + índice."
    )
    if skip:
        return {"policy": politica, "run_date_hint": None, "observations": []}
    return {
        "policy": politica,
        "run_date_hint": lote.batch_run_date if lote else None,
        "batch_id": lote.batch_id if lote else None,
        "batch_run_date": lote.batch_run_date if lote else None,
        "batch_run_date_source": lote.run_date_source if lote else None,
        "observations": observaciones,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pipeline Chill Index CICOMA")
    parser.add_argument("--output", default="data/chill_index.json")
    parser.add_argument("--evidence", default="evidence")
    parser.add_argument("--history", default="data/chill_history.jsonl")
    parser.add_argument("--batches", default="data/mini_batches.jsonl")
    parser.add_argument("--trigger", default="manual")
    parser.add_argument("--workflow-run-url", default=None)
    parser.add_argument("--skip-mini", action="store_true")
    args = parser.parse_args(argv)

    resumen = run(
        output=Path(args.output),
        evidence_root=Path(args.evidence),
        history_path=Path(args.history),
        batches_path=Path(args.batches),
        trigger=args.trigger,
        workflow_run_url=args.workflow_run_url,
        skip_mini=args.skip_mini,
    )
    print(json.dumps(resumen, ensure_ascii=False, indent=2))
    print()
    print(f"Estado del sistema : {resumen['status']}")
    print(f"Publicación        : {resumen['publication']}")
    for dia in resumen["days"]:
        if dia["availability"] == "DISPONIBLE":
            detalle = dia["risk"]
        elif dia["availability"] == "ERROR":
            detalle = f"ERROR ({dia['reason']})"
        else:
            detalle = f"SIN DATOS ({dia['reason']})"
        print(f"  {dia['date']}  {detalle}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
