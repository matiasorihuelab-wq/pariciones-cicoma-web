"""Descarga de mapas con registro completo de la evidencia.

Cada descarga deja constancia de todo lo que hace falta para reproducirla:
URL, momento, estado HTTP, encabezados de cacheo, tamaño y SHA-256 del cuerpo.
Un HTTP 200 **no** implica contenido utilizable: eso lo decide `imaging`.

Un HTTP 200 tampoco implica contenido VIGENTE. La fuente está detrás de una
CDN que puede responder a la URL canónica con un cuerpo que cacheó hace días
(ver `settings.MAX_EDGE_CACHE_AGE_SECONDS`). Por eso cada descarga mide la
antigüedad de borde y, si la respuesta es claramente rancia, repite el pedido
UNA sola vez con un parámetro que obliga al borde a consultar al origen.

La URL canónica sigue siendo la identidad del recurso: es la que se persiste y
la que entra en el contrato. La del bypass viaja aparte, como evidencia.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode, urlparse, urlunparse

import requests

from . import settings


@dataclass
class Fetch:
    """Resultado de una descarga, con su evidencia."""

    source_url: str
    requested_at: str
    http_status: int | None = None
    content_type: str | None = None
    content_length: int | None = None
    last_modified: str | None = None
    etag: str | None = None
    sha256: str | None = None
    body: bytes | None = field(default=None, repr=False)
    error: str | None = None
    attempts: int = 0
    elapsed_ms: int | None = None
    #: Antigüedad declarada por la CDN (`Age`) y su veredicto de caché para la
    #: respuesta CANÓNICA. No se pisan con los del bypass: son los que explican
    #: por qué se decidió repetir el pedido.
    age_seconds: int | None = None
    cache_status: str | None = None
    bypass_age_seconds: int | None = None
    bypass_cache_status: str | None = None
    #: Trazabilidad del bypass. `canonical_sha256` es el hash del PRIMER cuerpo;
    #: `sha256` termina siendo el del cuerpo efectivamente usado.
    cache_bypassed: bool = False
    canonical_sha256: str | None = None
    bypass_sha256: str | None = None
    bypass_url: str | None = None
    bypass_error: str | None = None
    stale_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.http_status == 200 and self.body is not None

    def last_modified_utc(self) -> datetime | None:
        """``Last-Modified`` como datetime con zona, o ``None`` si no vino."""

        if not self.last_modified:
            return None
        try:
            parsed = parsedate_to_datetime(self.last_modified)
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)

    def evidence(self) -> dict[str, Any]:
        """Lo que se publica y se archiva de esta descarga."""

        return {
            "source_url": self.source_url,
            "requested_at": self.requested_at,
            "http_status": self.http_status,
            "content_type": self.content_type,
            "content_length": self.content_length,
            "last_modified": self.last_modified,
            "etag": self.etag,
            "sha256": self.sha256,
            "attempts": self.attempts,
            "elapsed_ms": self.elapsed_ms,
            "error": self.error,
            # Caché de borde: sin esto, una respuesta rancia es indistinguible
            # de una fresca —las dos son 200 con `Last-Modified` coherente— y el
            # problema queda invisible en el diagnóstico.
            "age_seconds": self.age_seconds,
            "cache_status": self.cache_status,
            "bypass_age_seconds": self.bypass_age_seconds,
            "bypass_cache_status": self.bypass_cache_status,
            "cache_bypassed": self.cache_bypassed,
            "stale_reason": self.stale_reason,
            "canonical_sha256": self.canonical_sha256,
            "bypass_sha256": self.bypass_sha256,
            "bypass_url": self.bypass_url,
            "bypass_error": self.bypass_error,
        }


def _age_seconds(response: Any) -> int | None:
    """`Age` de la respuesta en segundos, o ``None`` si no vino o no es un número."""

    crudo = response.headers.get("Age")
    if crudo is None:
        return None
    try:
        return int(str(crudo).strip())
    except (TypeError, ValueError):
        return None


def _cache_status(response: Any) -> str | None:
    """Veredicto de caché de la CDN, normalizado a mayúsculas."""

    crudo = response.headers.get("CF-Cache-Status") or response.headers.get("X-Cache")
    if not crudo:
        return None
    return str(crudo).split(",")[0].strip().upper()


def stale_reason(cache_status: str | None, age: int | None) -> str | None:
    """Motivo por el que la respuesta canónica no es confiable, o ``None``.

    La regla es la del hallazgo: un cuerpo servido POR EL BORDE (no por el
    origen) y con más antigüedad que la tolerada. Un `MISS`, un `EXPIRED` o un
    `REVALIDATED` vienen del origen: son la corrida vigente aunque el objeto en
    sí sea de ayer, así que no se tocan.
    """

    if age is None or age <= settings.MAX_EDGE_CACHE_AGE_SECONDS:
        return None
    if cache_status is not None and cache_status not in settings.STALE_CACHE_STATUSES:
        return None
    horas = age / 3600
    etiqueta = cache_status or "sin veredicto de caché"
    return (
        f"Respuesta servida por el borde ({etiqueta}) con Age={age} s "
        f"({horas:.1f} h), por encima de las "
        f"{settings.MAX_EDGE_CACHE_AGE_SECONDS / 3600:.0f} h toleradas"
    )


def bypass_url(url: str, stamp: str) -> str:
    """URL con el parámetro que obliga al borde a consultar al origen.

    Determinista dentro de una corrida: el sello es el de la corrida, así que
    dos mapas de la misma ejecución comparten valor y una repetición del mismo
    pedido no multiplica objetos en la CDN.
    """

    partes = urlparse(url)
    marca = hashlib.sha256(stamp.encode("utf-8")).hexdigest()[:12]
    extra = urlencode({settings.CACHE_BUSTER_PARAM: marca})
    consulta = f"{partes.query}&{extra}" if partes.query else extra
    return urlunparse(partes._replace(query=consulta))


def _get(url: str, client: Any, result: Fetch) -> Any | None:
    """Un GET con reintentos y backoff. Devuelve la respuesta 200, o ``None``.

    Escribe en ``result`` el estado de la última respuesta vista. Nunca lanza:
    un 403 o un 429 se registran tal cual, sin reintentar indefinidamente y sin
    caer a ninguna otra fuente: si INIA bloquea al runner, eso es un hallazgo
    que debe verse, no taparse.
    """

    for attempt in range(1, settings.MAX_RETRIES + 1):
        result.attempts = attempt
        try:
            response = client.get(
                url,
                timeout=settings.TIMEOUT_SECONDS,
                headers={"User-Agent": settings.USER_AGENT},
            )
        except Exception as exc:  # noqa: BLE001 — cualquier fallo de red es dato
            result.error = f"{type(exc).__name__}: {exc}"
            if attempt < settings.MAX_RETRIES:
                time.sleep(settings.BACKOFF_BASE_SECONDS * attempt)
                continue
            return None
        result.http_status = int(response.status_code)
        result.content_type = response.headers.get("Content-Type")
        result.last_modified = response.headers.get("Last-Modified")
        result.etag = response.headers.get("ETag")
        result.error = None
        if response.status_code == 200:
            return response
        # 404 es una respuesta definitiva: el mapa no está publicado.
        if response.status_code == 404:
            result.error = "HTTP 404"
            return None
        result.error = f"HTTP {response.status_code}"
        if attempt < settings.MAX_RETRIES:
            time.sleep(settings.BACKOFF_BASE_SECONDS * attempt)
    return None


def _adoptar(response: Any, result: Fetch) -> str:
    """Toma el cuerpo de la respuesta como el cuerpo del resultado."""

    body = response.content
    result.body = body
    result.content_length = len(body)
    result.sha256 = hashlib.sha256(body).hexdigest()
    return result.sha256


def fetch(url: str, *, session: Any | None = None, now: datetime | None = None) -> Fetch:
    """Descarga la URL canónica y, si el borde la sirvió rancia, la repite UNA vez.

    El primer GET es siempre a la URL canónica y sin trucos: en el caso normal
    —la enorme mayoría— esto se comporta exactamente como antes. Sólo cuando la
    CDN admite haber servido de su caché un objeto más viejo que el umbral se
    hace un segundo GET con `cb`, y su cuerpo reemplaza al primero **si llega**.

    Si el bypass falla, el cuerpo rancio NO queda disponible como pronóstico:
    un mapa que se sabe viejo no puede publicarse como la corrida vigente (fue
    exactamente el incidente del 08/08: el cuerpo cacheado era una grilla
    vacía, pero con el mismo mecanismo pudo haber sido un CRÍTICO de hace tres
    días). El resultado queda sin cuerpo (`ok == False`) y el llamador lo
    publica como SIN_DATOS; el hash, los encabezados y el motivo del cuerpo
    rancio se conservan como EVIDENCIA en `canonical_*` y `stale_reason`.

    ``source_url`` no cambia nunca: es la identidad del recurso.
    """

    stamp = (now or datetime.now(UTC)).isoformat()
    result = Fetch(source_url=url, requested_at=stamp)
    client = session or requests
    started = time.monotonic()

    response = _get(url, client, result)
    if response is not None:
        result.canonical_sha256 = _adoptar(response, result)
        result.age_seconds = _age_seconds(response)
        result.cache_status = _cache_status(response)
        result.stale_reason = stale_reason(result.cache_status, result.age_seconds)

        if result.stale_reason is not None:
            segunda = Fetch(source_url=url, requested_at=stamp)
            destino = bypass_url(url, stamp)
            result.bypass_url = destino
            result.cache_bypassed = True
            fresca = _get(destino, client, segunda)
            if fresca is not None:
                result.bypass_sha256 = _adoptar(fresca, result)
                result.http_status = segunda.http_status
                result.content_type = segunda.content_type
                result.last_modified = segunda.last_modified
                result.etag = segunda.etag
                result.bypass_age_seconds = _age_seconds(fresca)
                result.bypass_cache_status = _cache_status(fresca)
                result.error = None
            else:
                # PROHIBIDO usar el cuerpo rancio como pronóstico vigente: se
                # retira del resultado. Su hash y sus encabezados ya quedaron
                # en `canonical_sha256` / `age_seconds` / `cache_status`.
                result.bypass_error = segunda.error or "el bypass no devolvió 200"
                result.body = None
                result.sha256 = None
                result.content_length = None
                result.error = (
                    "STALE_CACHE_UNRESOLVED: la CDN sirvió un cuerpo rancio "
                    f"({result.stale_reason}) y el bypass falló "
                    f"({result.bypass_error})"
                )
            result.attempts += segunda.attempts

    result.elapsed_ms = int((time.monotonic() - started) * 1000)
    return result


def wrf_url(day: Any) -> str:
    """URL del mapa WRF completo de una fecha."""

    return f"{settings.WRF_BASE}/{settings.WRF_PATTERN.format(date=day)}"


def mini_url(index: int) -> str:
    """URL de una miniatura. Sólo diagnóstico: nunca publica categorías."""

    return f"{settings.MINI_BASE}/{settings.MINI_PATTERN.replace('{index}', str(index))}"
