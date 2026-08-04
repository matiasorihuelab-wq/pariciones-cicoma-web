"""Construcción y validación del contrato publicado.

Reglas que el contrato hace cumplir, y que son la corrección de fondo:

* una fecha sin mapa válido **no** recibe categoría: va ``NO_DETERMINADO`` con
  ``display_status: SIN_DATOS`` y un motivo técnico;
* sin datos **no** hay ``ci_min`` ni ``ci_max``;
* el estado del sistema es un campo aparte del estado de cada día;
* ningún mapa se publica sin el SHA-256 de la imagen que se clasificó.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import settings

_SCHEMA_PATH = Path(__file__).parent / "schema" / "chill_index.schema.json"


class ContractError(ValueError):
    """El contrato no cumple el esquema o una invariante del dominio."""


def load_schema() -> dict[str, Any]:
    return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))


def unavailable_map(
    *,
    forecast_day: int,
    valid_date: str,
    source_url: str,
    availability_status: str,
    reason_code: str,
    reason_detail: str | None = None,
    validation_status: str = "NOT_FETCHED",
    sha256: str | None = None,
    last_modified: str | None = None,
    source_age_hours: float | None = None,
    http_status: int | None = None,
    evidence_path: str | None = None,
    checked_at: str | None = None,
) -> dict[str, Any]:
    """Una fecha sin pronóstico publicable: por falta de datos o por error.

    Nunca lleva categoría de riesgo ni intervalo. La diferencia entre las dos
    situaciones vive en ``availability_status`` y en el ``reason_code``:

    * ``SIN_DATOS`` → el pipeline funcionó y la fuente no tiene información
      utilizable para esa fecha;
    * ``ERROR`` → el pipeline no pudo procesar la fuente por una falla técnica.
    """

    if availability_status not in ("SIN_DATOS", "ERROR"):
        raise ContractError(f"Disponibilidad inesperada: {availability_status}")
    esperados = settings.REASON_NO_DATA if availability_status == "SIN_DATOS" else settings.REASON_ERROR
    if reason_code not in esperados:
        raise ContractError(
            f"El motivo {reason_code!r} no corresponde a {availability_status}"
        )
    return {
        "forecast_day": forecast_day,
        "valid_date": valid_date,
        "source_url": source_url,
        "source_sha256": sha256,
        "source_last_modified": last_modified,
        "source_age_hours": source_age_hours,
        "checked_at": checked_at,
        "http_status": http_status,
        "validation_status": validation_status,
        "risk_category": "NO_DETERMINADO",
        "availability_status": availability_status,
        "display_status": availability_status,
        "ci_min": None,
        "ci_max": None,
        "ci_unit": settings.CI_UNIT,
        "confidence": "none",
        "requires_review": False,
        "reason_code": reason_code,
        "reason_detail": reason_detail,
        "evidence_path": evidence_path,
    }


def risk_map(
    *,
    forecast_day: int,
    valid_date: str,
    source_url: str,
    sha256: str,
    last_modified: str | None,
    source_age_hours: float | None,
    http_status: int | None,
    category: str,
    confidence: str,
    evidence_path: str | None,
    checked_at: str | None = None,
) -> dict[str, Any]:
    """Una fecha con pronóstico publicable, con su intervalo de la leyenda."""

    if category not in settings.RISK_CATEGORIES or category == "NO_DETERMINADO":
        raise ContractError(f"Categoría no publicable: {category}")
    if confidence not in settings.CONFIDENCE_LEVELS or confidence == "none":
        raise ContractError(f"Confianza inválida para un dato publicado: {confidence}")
    internal = next(k for k, v in settings.RISK_PUBLIC_NAME.items() if v == category)
    ci_min, ci_max = settings.RISK_INTERVALS[internal]
    return {
        "forecast_day": forecast_day,
        "valid_date": valid_date,
        "source_url": source_url,
        "source_sha256": sha256,
        "source_last_modified": last_modified,
        "source_age_hours": source_age_hours,
        "checked_at": checked_at,
        "http_status": http_status,
        "validation_status": "VALID",
        "risk_category": category,
        "availability_status": "DISPONIBLE",
        "display_status": "DISPONIBLE",
        "ci_min": ci_min,
        "ci_max": ci_max,
        "ci_unit": settings.CI_UNIT,
        "confidence": confidence,
        "requires_review": confidence in ("low",),
        "reason_code": settings.REASON_VALID,
        "reason_detail": None,
        "evidence_path": evidence_path,
    }


STATUS_LABELS = {
    "ACTUALIZADO": "Pronóstico válido actualizado hoy",
    "DATOS_PARCIALES": "Pronóstico disponible parcialmente",
    "SIN_PRONOSTICO_CONFIABLE": "Fuente verificada hoy, sin datos utilizables",
    "DATOS_PARCIALES_CON_ERRORES": "Pronóstico parcial, con fallas técnicas en algunas fechas",
    "ERROR_DE_FUENTE": "No se pudo obtener la fuente oficial",
    "ERROR_DE_PIPELINE": "El pipeline no pudo procesar la fuente",
}

#: Errores atribuibles a la red o a la respuesta de la fuente, frente a los que
#: son nuestros (imagen, clasificador, validación, publicación).
_ERRORES_DE_FUENTE = frozenset(
    {
        "SOURCE_TIMEOUT",
        "SOURCE_HTTP_403",
        "SOURCE_HTTP_404",
        "SOURCE_HTTP_429",
        "SOURCE_HTTP_5XX",
    }
)


def system_status(maps: list[dict[str, Any]], *, today_iso: str) -> str:
    """Estado del **sistema**, distinto del estado de cada día.

    Que un día diga «Sin datos» no significa que el pipeline haya fallado: una
    corrida técnicamente correcta puede terminar legítimamente sin datos
    publicables. Un `ERROR`, en cambio, sí señala una falla técnica.
    """

    publicables = [m for m in maps if m["availability_status"] == "DISPONIBLE"]
    errores = [m for m in maps if m["availability_status"] == "ERROR"]

    if errores and not publicables and not [m for m in maps if m["availability_status"] == "SIN_DATOS"]:
        # Todas las fechas fallaron: distinguir si fue la fuente o nosotros.
        de_fuente = all(m.get("reason_code") in _ERRORES_DE_FUENTE for m in errores)
        return "ERROR_DE_FUENTE" if de_fuente else "ERROR_DE_PIPELINE"
    if errores and publicables:
        return "DATOS_PARCIALES_CON_ERRORES"
    if errores:
        # Errores mezclados con SIN_DATOS y ninguna fecha publicable.
        return "DATOS_PARCIALES_CON_ERRORES" if publicables else "ERROR_DE_PIPELINE"
    if not publicables:
        return "SIN_PRONOSTICO_CONFIABLE"
    hoy = next((m for m in maps if m["valid_date"] == today_iso), None)
    if (
        hoy is not None
        and hoy["availability_status"] == "DISPONIBLE"
        and len(publicables) == len(maps)
    ):
        return "ACTUALIZADO"
    return "DATOS_PARCIALES"


def validate(payload: dict[str, Any], *, today_iso: str | None = None) -> None:
    """Valida contra el esquema y contra las invariantes del dominio.

    ``today_iso`` viaja como argumento, no dentro del contrato: el payload que
    se valida es exactamente el que se publica, sin campos auxiliares.

    Se usa ``jsonschema`` si está disponible; si no, se aplica la validación
    estructural mínima propia. Las invariantes se comprueban siempre.
    """

    try:
        import jsonschema  # type: ignore[import-untyped]

        jsonschema.validate(payload, load_schema())
    except ImportError:
        _validate_minimal(payload)
    except Exception as exc:  # noqa: BLE001
        raise ContractError(f"El contrato no cumple el esquema: {exc}") from exc

    _validate_invariants(payload, today_iso=today_iso)


def _validate_minimal(payload: dict[str, Any]) -> None:
    schema = load_schema()
    for key in schema["required"]:
        if key not in payload:
            raise ContractError(f"Falta el campo obligatorio '{key}'")
    if payload["status"] not in settings.SYSTEM_STATUS:
        raise ContractError(f"Estado de sistema desconocido: {payload['status']}")
    if not isinstance(payload["maps"], list) or not payload["maps"]:
        raise ContractError("El contrato debe publicar al menos un mapa")


def _validate_invariants(payload: dict[str, Any], *, today_iso: str | None = None) -> None:
    fechas = set()
    for item in payload["maps"]:
        etiqueta = item["valid_date"]
        if etiqueta in fechas:
            raise ContractError(f"Fecha repetida en el horizonte: {etiqueta}")
        fechas.add(etiqueta)

        if item["risk_category"] not in settings.RISK_CATEGORIES:
            raise ContractError(f"Categoría fuera de la enumeración: {item['risk_category']}")
        if item["confidence"] not in settings.CONFIDENCE_LEVELS:
            raise ContractError(f"Confianza fuera de la enumeración: {item['confidence']}")

        disponibilidad = item["availability_status"]
        if disponibilidad not in settings.AVAILABILITY_STATUS:
            raise ContractError(f"Disponibilidad desconocida: {disponibilidad}")
        if item["display_status"] != disponibilidad:
            raise ContractError(f"{etiqueta}: display_status no coincide con availability_status")
        sin_datos = disponibilidad != "DISPONIBLE"
        if sin_datos:
            if item["risk_category"] != "NO_DETERMINADO":
                raise ContractError(f"{etiqueta}: sin datos no puede tener categoría de riesgo")
            if item["ci_min"] is not None or item["ci_max"] is not None:
                raise ContractError(f"{etiqueta}: sin datos no puede declarar intervalo de CI")
            if item["confidence"] != "none":
                raise ContractError(f"{etiqueta}: sin datos exige confianza 'none'")
            esperados = (
                settings.REASON_NO_DATA
                if disponibilidad == "SIN_DATOS"
                else settings.REASON_ERROR
            )
            if item["reason_code"] not in esperados:
                raise ContractError(
                    f"{etiqueta}: el motivo {item['reason_code']!r} no corresponde a "
                    f"{disponibilidad}"
                )
        else:
            if item["risk_category"] == "NO_DETERMINADO":
                raise ContractError(f"{etiqueta}: un dato disponible no puede ser NO_DETERMINADO")
            if not item["source_sha256"]:
                raise ContractError(f"{etiqueta}: no se publica un mapa sin hash de evidencia")
            if item["validation_status"] != "VALID":
                raise ContractError(f"{etiqueta}: sólo se publica un mapa VALID")
            interno = next(
                k for k, v in settings.RISK_PUBLIC_NAME.items() if v == item["risk_category"]
            )
            esperado = settings.RISK_INTERVALS[interno]
            if (item["ci_min"], item["ci_max"]) != esperado:
                raise ContractError(
                    f"{etiqueta}: intervalo {item['ci_min']}–{item['ci_max']} no corresponde "
                    f"a {item['risk_category']} (leyenda: {esperado[0]}–{esperado[1]})"
                )

    esperado_estado = system_status(payload["maps"], today_iso=today_iso or "")
    if payload["status"] == "ACTUALIZADO" and esperado_estado != "ACTUALIZADO":
        raise ContractError("ACTUALIZADO exige serie completa y vigente para el día de hoy")
