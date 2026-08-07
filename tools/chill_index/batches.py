"""Identidad temporal del juego de miniaturas (WRF_mini).

Un juego ``Min_0..Min_4`` pertenece a UNA corrida de INIA. La regla canónica,
demostrada por los reportes históricos del proyecto (28/07 y 29/07):

    valid_date(Min_N) = batch_run_date + N

y **no** ``hoy + N``. Los rótulos «Hoy | Mañana | Pasado | Hoy+3 | Hoy+4» de la
página describen correctamente un juego FRESCO, pero no deben desplazar un lote
antiguo que INIA siga sirviendo: al cruzar la medianoche el lote no cambia de
fechas.

La auditoría del 2026-08-06 demostró además que INIA **oscila** entre lotes bajo
URLs estables: el mismo juego apareció el 04/08, desapareció el 05/08 y volvió
el 06/08. Por eso el lote se reconoce por el hash de sus cinco miembros —no por
la fecha en que se lo vio— y su fecha base se persiste entre ejecuciones.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from . import settings

#: Un lote cuya fecha base no puede establecerse con seguridad. No se le
#: asignan ``valid_date``: se prefiere no publicar antes que adivinar.
UNDETERMINED = "BATCH_DATE_UNDETERMINED"

#: Lotes cuya fecha base quedó fijada por auditoría, con la evidencia que la
#: sostiene. Sirven de semilla: sin esto, un lote observado antes de que
#: existiera la persistencia se re-derivaría en cada corrida.
SEEDED_BATCHES: dict[str, dict[str, Any]] = {
    "3904c26b5f6d9fb1": {
        "batch_run_date": "2026-08-04",
        "evidence": (
            "Auditoría 2026-08-06: primera aparición en "
            "AUDITORIA_CHILL_SHADOW/images/20260804 y Last-Modified de los cinco "
            "miembros en el 04/08 hora de Uruguay. Las dos señales concuerdan."
        ),
    },
}


def batch_id(hashes: dict[int, str]) -> str:
    """Identificador determinístico del juego, a partir de sus cinco cuerpos."""

    concatenado = "".join(hashes[i] for i in sorted(hashes))
    return hashlib.sha256(concatenado.encode("utf-8")).hexdigest()[:16]


@dataclass
class MiniBatch:
    batch_id: str
    batch_run_date: str | None
    first_seen_at: str
    last_seen_at: str
    members: dict[str, dict[str, Any]] = field(default_factory=dict)
    run_date_source: str = ""

    def valid_date_of(self, index: int) -> date | None:
        """Fecha que predice el slot ``index``. ``None`` si el lote no tiene fecha."""

        if not self.batch_run_date:
            return None
        return date.fromisoformat(self.batch_run_date) + timedelta(days=index)

    def index_for(self, valid_date: date) -> int | None:
        """Slot de este lote que predice esa fecha, si lo hay."""

        if not self.batch_run_date:
            return None
        indice = (valid_date - date.fromisoformat(self.batch_run_date)).days
        return indice if 0 <= indice < settings.HORIZON_DAYS else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "batch_run_date": self.batch_run_date,
            "first_seen_at": self.first_seen_at,
            "last_seen_at": self.last_seen_at,
            "run_date_source": self.run_date_source,
            "members": self.members,
        }


def _local_date(last_modified_utc: datetime | None) -> date | None:
    if last_modified_utc is None:
        return None
    return last_modified_utc.astimezone(ZoneInfo(settings.TIMEZONE)).date()


def derive_run_date(members: dict[str, dict[str, Any]]) -> tuple[str | None, str]:
    """Fecha base de un lote NUEVO, con política conservadora.

    Evidencia admitida: el ``Last-Modified`` de cada miembro llevado a hora de
    Uruguay. Si todos los que existen caen en el MISMO día local, esa es la
    fecha base. Si se contradicen —o no hay ninguno— el lote queda
    ``BATCH_DATE_UNDETERMINED`` y no se le asignan fechas.

    ``first_seen_at`` NO se usa como fecha base: es evidencia auxiliar. Un lote
    puede verse por primera vez días después de haberse generado.
    """

    fechas: set[date] = set()
    for datos in members.values():
        crudo = datos.get("last_modified_utc")
        if not crudo:
            continue
        try:
            momento = datetime.fromisoformat(crudo)
        except ValueError:
            continue
        local = _local_date(momento)
        if local is not None:
            fechas.add(local)
    if len(fechas) == 1:
        unica = fechas.pop()
        return (
            unica.isoformat(),
            "Last-Modified coincidente de los miembros (hora de Uruguay)",
        )
    if not fechas:
        return None, "ningún miembro trajo Last-Modified"
    return (
        None,
        f"Last-Modified contradictorio: {sorted(f.isoformat() for f in fechas)}",
    )


def read_batches(path: Path) -> dict[str, MiniBatch]:
    """Lotes ya conocidos, del archivo persistido y versionado."""

    lotes: dict[str, MiniBatch] = {}
    if path.is_file():
        for linea in path.read_text(encoding="utf-8").splitlines():
            if not linea.strip():
                continue
            try:
                d = json.loads(linea)
            except json.JSONDecodeError:
                continue
            lotes[d["batch_id"]] = MiniBatch(
                batch_id=d["batch_id"],
                batch_run_date=d.get("batch_run_date"),
                first_seen_at=d.get("first_seen_at", ""),
                last_seen_at=d.get("last_seen_at", ""),
                members=d.get("members", {}),
                run_date_source=d.get("run_date_source", ""),
            )
    # Las semillas sólo completan lo que el archivo todavía no fijó.
    for bid, semilla in SEEDED_BATCHES.items():
        lote = lotes.get(bid)
        if lote is None:
            lotes[bid] = MiniBatch(
                batch_id=bid,
                batch_run_date=semilla["batch_run_date"],
                first_seen_at="",
                last_seen_at="",
                run_date_source=semilla["evidence"],
            )
        elif not lote.batch_run_date:
            lote.batch_run_date = semilla["batch_run_date"]
            lote.run_date_source = semilla["evidence"]
    return lotes


def write_batches(path: Path, lotes: dict[str, MiniBatch]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lineas = [
        json.dumps(lote.to_dict(), ensure_ascii=False, sort_keys=True)
        for lote in lotes.values()
    ]
    path.write_text("\n".join(lineas) + "\n", encoding="utf-8")


def observe(
    path: Path, members: dict[str, dict[str, Any]], *, now: datetime
) -> tuple[MiniBatch, dict[str, MiniBatch]]:
    """Registra el lote observado y devuelve su identidad, con su fecha base.

    Si el lote YA se conocía, se reutiliza su ``batch_run_date`` persistida y
    sólo se actualiza ``last_seen_at``: que INIA vuelva a servir un lote viejo
    no lo convierte en la corrida de hoy.
    """

    hashes = {int(k): v["sha256"] for k, v in members.items() if v.get("sha256")}
    bid = batch_id(hashes) if hashes else ""
    lotes = read_batches(path)
    sello = now.astimezone(timezone.utc).isoformat()
    if not bid:
        vacio = MiniBatch(
            batch_id="",
            batch_run_date=None,
            first_seen_at=sello,
            last_seen_at=sello,
            run_date_source="ningún mini descargado",
        )
        return vacio, lotes
    if bid in lotes:
        lote = lotes[bid]
        lote.last_seen_at = sello
        if not lote.members:
            lote.members = members
        if not lote.first_seen_at:
            lote.first_seen_at = sello
    else:
        fecha, motivo = derive_run_date(members)
        lote = MiniBatch(
            batch_id=bid,
            batch_run_date=fecha,
            first_seen_at=sello,
            last_seen_at=sello,
            members=members,
            run_date_source=motivo if fecha else f"{UNDETERMINED}: {motivo}",
        )
        lotes[bid] = lote
    write_batches(path, lotes)
    return lote, lotes


def forecast_for(
    valid_date: date, lotes: dict[str, MiniBatch]
) -> list[tuple[MiniBatch, int]]:
    """Lotes que predicen esa fecha, del más reciente al más antiguo.

    Varios lotes pueden tener un slot para la misma fecha. Se evalúan en orden
    de ``batch_run_date`` descendente: el pronóstico más reciente manda, y si
    resulta inválido se puede caer al anterior conservando la trazabilidad.
    """

    candidatos: list[tuple[MiniBatch, int]] = []
    for lote in lotes.values():
        indice = lote.index_for(valid_date)
        if indice is not None:
            candidatos.append((lote, indice))
    candidatos.sort(key=lambda par: par[0].batch_run_date or "", reverse=True)
    return candidatos
