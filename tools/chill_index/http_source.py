"""Descarga de mapas con registro completo de la evidencia.

Cada descarga deja constancia de todo lo que hace falta para reproducirla:
URL, momento, estado HTTP, encabezados de cacheo, tamaño y SHA-256 del cuerpo.
Un HTTP 200 **no** implica contenido utilizable: eso lo decide `imaging`.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

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
        }


def fetch(url: str, *, session: Any | None = None, now: datetime | None = None) -> Fetch:
    """Descarga con reintentos y backoff. Nunca lanza: el fallo viaja en ``error``.

    Un 403 o un 429 se registran tal cual, sin reintentar indefinidamente y sin
    caer a ninguna otra fuente: si INIA bloquea al runner, eso es un hallazgo
    que debe verse, no taparse.
    """

    stamp = (now or datetime.now(UTC)).isoformat()
    result = Fetch(source_url=url, requested_at=stamp)
    client = session or requests
    started = time.monotonic()
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
            break
        result.http_status = int(response.status_code)
        result.content_type = response.headers.get("Content-Type")
        result.last_modified = response.headers.get("Last-Modified")
        result.etag = response.headers.get("ETag")
        result.error = None
        if response.status_code == 200:
            body = response.content
            result.body = body
            result.content_length = len(body)
            result.sha256 = hashlib.sha256(body).hexdigest()
            break
        # 404 es una respuesta definitiva: el mapa no está publicado.
        if response.status_code == 404:
            result.error = "HTTP 404"
            break
        result.error = f"HTTP {response.status_code}"
        if attempt < settings.MAX_RETRIES:
            time.sleep(settings.BACKOFF_BASE_SECONDS * attempt)
    result.elapsed_ms = int((time.monotonic() - started) * 1000)
    return result


def wrf_url(day: Any) -> str:
    """URL del mapa WRF completo de una fecha."""

    return f"{settings.WRF_BASE}/{settings.WRF_PATTERN.format(date=day)}"


def mini_url(index: int) -> str:
    """URL de una miniatura. Sólo diagnóstico: nunca publica categorías."""

    return f"{settings.MINI_BASE}/{settings.MINI_PATTERN.replace('{index}', str(index))}"
