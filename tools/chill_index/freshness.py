"""Vigencia: una sola función, probada, para decidir si un dato sigue vivo.

El defecto que corrige: la antigüedad se calculaba desde la **importación**, así
que volver a leer el mismo archivo la reiniciaba a cero y un pronóstico de hace
seis días se mostraba como recién actualizado.

Acá la antigüedad se mide **desde la fuente** —el ``Last-Modified`` del mapa o
la fecha de la corrida—, nunca desde la descarga. Descargar de nuevo lo mismo no
rejuvenece nada.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime

from . import settings


@dataclass
class Freshness:
    """Veredicto de vigencia de un mapa concreto."""

    verified: bool
    source_age_hours: float | None
    reason: str | None = None


def source_age_hours(last_modified: datetime | None, *, now: datetime) -> float | None:
    """Horas transcurridas desde que la fuente generó el archivo.

    ``None`` si la fuente no declara ``Last-Modified``: la antigüedad es
    entonces **desconocida**, que no es lo mismo que cero.
    """

    if last_modified is None:
        return None
    delta = now.astimezone(UTC) - last_modified.astimezone(UTC)
    return delta.total_seconds() / 3600.0


def evaluate_source(
    last_modified: datetime | None,
    *,
    now: datetime,
    max_age_hours: float = settings.MAX_SOURCE_AGE_HOURS,
) -> Freshness:
    """¿La corrida que publicó este mapa es lo bastante reciente?

    Sin ``Last-Modified`` no se puede verificar la fecha de la corrida y el mapa
    **no se publica**: es exactamente el error que llevó a presentar miniaturas
    del 30/07 como pronóstico del 03/08.
    """

    age = source_age_hours(last_modified, now=now)
    if age is None:
        return Freshness(
            verified=False,
            source_age_hours=None,
            reason="SOURCE_DATE_UNVERIFIED",
        )
    if age > max_age_hours:
        return Freshness(
            verified=False,
            source_age_hours=round(age, 2),
            reason="SOURCE_DATE_UNVERIFIED",
        )
    if age < -1.0:
        # Reloj de la fuente adelantado más de una hora: no se acepta.
        return Freshness(
            verified=False,
            source_age_hours=round(age, 2),
            reason="SOURCE_DATE_UNVERIFIED",
        )
    return Freshness(verified=True, source_age_hours=round(age, 2))


def horizon_expired(valid_date: date, *, today: date) -> bool:
    """¿La fecha del pronóstico ya pasó?"""

    return valid_date < today


def carry_forward_age(
    previous_forecast_run_date: str | None,
    *,
    today: date,
) -> int | None:
    """Días transcurridos desde la última corrida válida conocida.

    Se usa para informar «último pronóstico válido: hace N días». Una serie
    repetida **conserva** su antigüedad original: no se reinicia porque se haya
    vuelto a descargar, ni porque el proceso se haya reiniciado.
    """

    if not previous_forecast_run_date:
        return None
    try:
        previous = date.fromisoformat(previous_forecast_run_date)
    except ValueError:
        return None
    return (today - previous).days
