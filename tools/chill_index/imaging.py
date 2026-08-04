"""Validación de contenido de un mapa. Un HTTP 200 no es un mapa con datos.

El caso que motivó todo esto: INIA publica el PNG completo —dimensiones
correctas, marco, leyenda y títulos— pero con la grilla **vacía**. Se detecta
midiendo cuántos píxeles de la paleta hay dentro del marco geográfico.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

from PIL import Image

from . import settings

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: Estados posibles de un mapa descargado.
VALID = "VALID"
NO_DATA = "NO_DATA"
INVALID_IMAGE = "INVALID_IMAGE"
INDETERMINATE = "INDETERMINATE"


@dataclass
class ImageCheck:
    status: str
    reason: str = ""
    width: int | None = None
    height: int | None = None
    palette_coverage: float | None = None
    image: Image.Image | None = None


def _lab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """RGB (0-255) a CIELAB D65. Implementación explícita: sin dependencias extra."""

    def _srgb(channel: float) -> float:
        c = channel / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (_srgb(v) for v in rgb)
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    def _f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t) + (16 / 116)

    fx, fy, fz = _f(x), _f(y), _f(z)
    return (116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)


_PALETTE_LAB = {name: _lab(rgb) for name, rgb in settings.PALETTE.items()}


def nearest_palette(rgb: tuple[int, int, int]) -> tuple[str | None, float]:
    """Categoría de paleta más cercana en CIELAB y su distancia.

    Devuelve ``(None, distancia)`` si ninguna queda dentro del umbral: un color
    que no es de la leyenda no se fuerza a la categoría más parecida.
    """

    lab = _lab(rgb)
    best: tuple[str | None, float] = (None, float("inf"))
    for name, ref in _PALETTE_LAB.items():
        distance = sum((a - b) ** 2 for a, b in zip(lab, ref, strict=True)) ** 0.5
        if distance < best[1]:
            best = (name, distance)
    if best[1] > settings.LAB_MATCH_THRESHOLD:
        return None, best[1]
    return best


def check_wrf(content: bytes, calibration: dict[str, Any]) -> ImageCheck:
    """Valida un WRF completo: formato, dimensiones y grilla con datos."""

    if not content.startswith(PNG_SIGNATURE):
        return ImageCheck(status=INVALID_IMAGE, reason="El contenido no es un PNG")
    try:
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        return ImageCheck(status=INVALID_IMAGE, reason=f"PNG ilegible: {exc}")

    width, height = image.size
    expected = tuple(settings.WRF_EXPECTED_SIZE)
    if (width, height) != expected:
        return ImageCheck(
            status=INVALID_IMAGE,
            reason=f"Dimensiones {width}x{height}, se esperaban {expected[0]}x{expected[1]}",
            width=width,
            height=height,
        )

    frame = calibration["frame"]
    x0, y0 = int(frame["x0"]), int(frame["y0"])
    x1, y1 = int(frame["x1"]), int(frame["y1"])
    pixels = image.load()
    total = 0
    palette_hits = 0
    # Muestreo cada 2 px: suficiente para medir cobertura y diez veces más rápido.
    for y in range(y0 + 1, y1, 2):
        for x in range(x0 + 1, x1, 2):
            total += 1
            name, _ = nearest_palette(pixels[x, y])
            if name is not None:
                palette_hits += 1
    coverage = palette_hits / total if total else 0.0

    if coverage <= settings.MAX_PALETTE_COVERAGE_NO_DATA:
        return ImageCheck(
            status=NO_DATA,
            reason=(
                "Grilla vacía: sin colores de paleta dentro del marco "
                "(patrón 'Entire Grid Undefined')"
            ),
            width=width,
            height=height,
            palette_coverage=round(coverage, 4),
            image=image,
        )
    if coverage < settings.MIN_PALETTE_COVERAGE_VALID:
        return ImageCheck(
            status=INDETERMINATE,
            reason=(
                f"Cobertura de paleta {coverage:.1%} por debajo del mínimo "
                f"{settings.MIN_PALETTE_COVERAGE_VALID:.0%}: contenido dudoso"
            ),
            width=width,
            height=height,
            palette_coverage=round(coverage, 4),
            image=image,
        )
    return ImageCheck(
        status=VALID,
        reason="",
        width=width,
        height=height,
        palette_coverage=round(coverage, 4),
        image=image,
    )
