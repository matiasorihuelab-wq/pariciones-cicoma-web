"""Clasificación determinística del píxel de CICOMA. Sin IA generativa.

La categoría sale de comparar el color del mapa contra la paleta calibrada en
CIELAB, sobre una ventana de píxeles alrededor de la coordenada del
establecimiento. El mismo PNG produce siempre el mismo resultado: eso es lo que
permite reproducir una clasificación histórica a partir del hash de la imagen.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from PIL import Image

from . import settings
from .imaging import nearest_palette


@dataclass
class Classification:
    category: str | None
    confidence: str
    pixel: tuple[int, int] | None = None
    votes: dict[str, int] | None = None
    reason: str = ""
    near_border: bool = False


def latlon_to_pixel(cal: dict[str, Any], lat: float, lon: float) -> tuple[float, float]:
    """Coordenada geográfica a píxel, usando el marco calibrado."""

    frame = cal["frame"]
    fx = (lon - cal["lon_min"]) / (cal["lon_max"] - cal["lon_min"])
    fy = (cal["lat_max"] - lat) / (cal["lat_max"] - cal["lat_min"])
    return (
        frame["x0"] + fx * (frame["x1"] - frame["x0"]),
        frame["y0"] + fy * (frame["y1"] - frame["y0"]),
    )


def inside_domain(cal: dict[str, Any], lat: float, lon: float) -> bool:
    """¿La ubicación cae dentro del dominio del mapa?"""

    return cal["lon_min"] <= lon <= cal["lon_max"] and cal["lat_min"] <= lat <= cal["lat_max"]


def classify(
    image: Image.Image,
    cal: dict[str, Any],
    *,
    lat: float,
    lon: float,
    window: int = settings.CLASSIFICATION_WINDOW,
) -> Classification:
    """Categoría dominante en la ventana centrada en la ubicación.

    Sin mayoría clara o con colores fuera de la leyenda, devuelve ``None``: no
    se inventa una categoría ni se elige «la más parecida».
    """

    if not inside_domain(cal, lat, lon):
        return Classification(
            category=None,
            confidence="none",
            reason="La ubicación está fuera del dominio del mapa",
        )

    x, y = latlon_to_pixel(cal, lat, lon)
    px, py = int(round(x)), int(round(y))
    half = window // 2
    pixels = image.load()
    width, height = image.size
    votes: Counter[str] = Counter()
    sampled = 0
    for dy in range(-half, half + 1):
        for dx in range(-half, half + 1):
            sx, sy = px + dx, py + dy
            if not (0 <= sx < width and 0 <= sy < height):
                continue
            sampled += 1
            name, _ = nearest_palette(pixels[sx, sy])
            if name is not None:
                votes[name] += 1

    if not votes:
        return Classification(
            category=None,
            confidence="none",
            pixel=(px, py),
            votes={},
            reason="Ningún píxel de la ventana coincide con la paleta de la leyenda",
        )

    (winner, top), *rest = votes.most_common()
    share = top / sampled if sampled else 0.0
    runner_up = rest[0][1] if rest else 0
    near_border = bool(rest) and (top - runner_up) <= max(1, top * 0.25)

    # Confianza: el WRF completo llega como máximo a "high"; una ventana
    # repartida entre dos categorías baja a "medium" y una minoritaria a "low".
    if share >= 0.75 and not near_border:
        confidence = "high"
    elif share >= 0.5:
        confidence = "medium"
    else:
        confidence = "low"

    return Classification(
        category=settings.RISK_PUBLIC_NAME[winner],
        confidence=confidence,
        pixel=(px, py),
        votes=dict(votes),
        near_border=near_border,
        reason="",
    )
