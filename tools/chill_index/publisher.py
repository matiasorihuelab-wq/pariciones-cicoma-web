"""Publicación atómica del contrato y archivo inmutable de la evidencia.

Una ruta fija y única (`data/chill_index.json`). Nunca nombres alternativos:
el `(1).json` / `(2).json` de Drive es justamente el defecto que se elimina.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


#: Campos que cambian en cada corrida sin que cambie el pronóstico: los sellos
#: de ejecución, la antigüedad medida (que avanza sola con el reloj) y el
#: diagnóstico, que registra cada consulta HTTP.
_VOLATILE_TOP = ("run_started_at", "run_finished_at", "run_trigger", "diagnostics")
#: `checked_at` y `latest_source_seen` son la hora en que MIRAMOS, no el
#: pronóstico. Contaban para el hash y rompían en silencio la idempotencia que
#: este módulo promete: desde que se agregó `checked_at` toda corrida reescribía
#: el archivo y dejaba un commit sin información nueva (verificado el 2026-08-07
#: sobre dos corridas productivas consecutivas cuyo único cambio eran sellos).
#: Que no cuenten para el hash no las congela: `cli.run()` refresca el archivo
#: una vez por día local para que «última verificación» nunca mienta.
_VOLATILE_NESTED = ("source_age_hours", "checked_at", "latest_source_seen")


def _stable_view(payload: dict[str, Any]) -> dict[str, Any]:
    """Copia del contrato sin lo que varía por el mero paso del tiempo."""

    reducido = {k: v for k, v in payload.items() if k not in _VOLATILE_TOP}
    frescura = dict(reducido.get("freshness") or {})
    for clave in _VOLATILE_NESTED:
        frescura.pop(clave, None)
    if frescura:
        reducido["freshness"] = frescura
    reducido["maps"] = [
        {k: v for k, v in mapa.items() if k not in _VOLATILE_NESTED}
        for mapa in reducido.get("maps", [])
    ]
    return reducido


def payload_hash(payload: dict[str, Any]) -> str:
    """Hash del contenido **significativo**: ignora lo que cambia con el reloj.

    Sin esto, cada ejecución reescribiría el archivo aunque la fuente no hubiera
    cambiado —la antigüedad medida avanza sola— y el repositorio se llenaría de
    commits sin información nueva. Lo que sí cambia el hash es el pronóstico:
    otra categoría, otra fecha, otro hash de imagen u otro estado.
    """

    texto = json.dumps(_stable_view(payload), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def read_previous(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_atomic(path: Path, payload: dict[str, Any]) -> str:
    """Escribe el contrato de forma atómica y devuelve el SHA-256 del archivo."""

    path.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    datos = texto.encode("utf-8")
    handle, temporal = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as archivo:
            archivo.write(datos)
            archivo.flush()
            os.fsync(archivo.fileno())
        os.replace(temporal, path)
    except BaseException:
        Path(temporal).unlink(missing_ok=True)
        raise
    verificado = hashlib.sha256(path.read_bytes()).hexdigest()
    esperado = hashlib.sha256(datos).hexdigest()
    if verificado != esperado:
        raise OSError("El archivo publicado no coincide con el contenido generado")
    return verificado


def store_evidence(root: Path, *, day: str, sha256: str, content: bytes) -> str:
    """Guarda una copia inmutable de la imagen analizada.

    Identificada por fecha y hash. Si ya existe ese hash no se reescribe: las
    grillas vacías son byte a byte idénticas y una sola copia alcanza como
    prueba.
    """

    destino = root / day / f"{sha256[:16]}.png"
    if destino.exists():
        return destino.as_posix()
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(content)
    return destino.as_posix()
