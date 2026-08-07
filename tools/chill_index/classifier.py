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


def classify_mini(
    image: Image.Image,
    cal: dict[str, Any],
    *,
    lat: float,
    lon: float,
    window: int = settings.MINI_CLASSIFICATION_WINDOW,
) -> Classification:
    """Categoría en el WRF_mini, con su PROPIA calibración y su propia regla.

    El mini cubre la misma extensión geográfica con 117×98 px en vez de
    780×650: un píxel son ≈7,7 km. A esa resolución CICOMA puede caer sobre una
    transición entre dos categorías, así que exigir unanimidad descartaría
    información útil. La regla es:

    * pocos píxeles de paleta        → ``None`` (no se inventa nada);
    * una categoría dominante        → esa categoría;
    * dos categorías ADYACENTES sin dominante → la de MAYOR riesgo, por
      precaución, y con confianza ``low``.

    Los píxeles que no pertenecen a la paleta (blanco, negro cartográfico,
    texto, costas, límites) se excluyen: no votan.
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
    assert pixels is not None
    width, height = image.size
    votes: Counter[str] = Counter()
    sampled = 0
    for dy in range(-half, half + 1):
        for dx in range(-half, half + 1):
            sx, sy = px + dx, py + dy
            if not (0 <= sx < width and 0 <= sy < height):
                continue
            sampled += 1
            color = pixels[sx, sy]
            if not isinstance(color, tuple) or len(color) < 3:
                continue
            name, _ = nearest_palette((color[0], color[1], color[2]))
            if name is not None:
                votes[name] += 1

    validos = sum(votes.values())
    if validos < settings.MINI_MIN_VALID_PIXELS:
        return Classification(
            category=None,
            confidence="none",
            pixel=(px, py),
            votes=dict(votes),
            reason=(
                f"Sólo {validos} píxeles de paleta en la ventana del mini "
                f"(mínimo {settings.MINI_MIN_VALID_PIXELS}): no alcanza para clasificar"
            ),
        )

    (winner, top), *rest = votes.most_common()
    share = top / validos
    if share >= settings.MINI_DOMINANT_SHARE:
        return Classification(
            category=settings.RISK_PUBLIC_NAME[winner],
            confidence="medium",
            pixel=(px, py),
            votes=dict(votes),
            near_border=False,
            reason="Categoría dominante en la ventana del mini",
        )

    # Sin dominante: sólo se resuelve si las dos primeras son VECINAS en la
    # escala. Dos categorías lejanas conviviendo indican que la ventana cruza
    # regiones distintas y no se puede afirmar una sola.
    segundo = rest[0][0] if rest else winner
    escala = settings.RISK_SCALE
    if abs(escala.index(winner) - escala.index(segundo)) != 1:
        return Classification(
            category=None,
            confidence="none",
            pixel=(px, py),
            votes=dict(votes),
            reason=(
                f"La ventana del mini mezcla {winner} y {segundo}, que no son "
                "adyacentes en la escala: no se elige una"
            ),
        )
    if not settings.MINI_PRECAUTIONARY_ADJACENT:
        return Classification(
            category=None,
            confidence="none",
            pixel=(px, py),
            votes=dict(votes),
            reason="Frontera cromática sin criterio precautorio habilitado",
        )
    mayor = winner if escala.index(winner) > escala.index(segundo) else segundo
    return Classification(
        category=settings.RISK_PUBLIC_NAME[mayor],
        confidence="low",
        pixel=(px, py),
        votes=dict(votes),
        near_border=True,
        reason=(
            f"Frontera {winner}/{segundo} en la resolución del mini: se publica "
            f"{mayor} por criterio precautorio"
        ),
    )
