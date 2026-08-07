"""Configuración del pipeline Chill Index. Sin dependencias de red ni de disco local.

Los valores de paleta, intervalos y calibración provienen de la auditoría
`AUDITORIA_CHILL_SHADOW` (2026-07-30 → 2026-08-03) y están congelados acá para
que un resultado publicado pueda reproducirse con exactitud a partir del commit
del código.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

#: Versión del pipeline. Se publica en el contrato: cambiar la clasificación
#: sin cambiar esto haría irreproducible un resultado histórico.
PIPELINE_VERSION = "1.1.0"
SCHEMA_VERSION = "1.1.0"

TIMEZONE = "America/Montevideo"

SOURCE_NAME = "INIA-GRAS"
SOURCE_PAGE = "https://inia.uy/gras/Aplicaciones_y_recursos/Prevision%20Corderos"
WRF_BASE = (
    "https://www.inia.uy/sites/default/files/gras/contenidogras/Reportes/"
    "agroclima/AlertaOvinos/WRF"
)
WRF_PATTERN = "Chill_wrf{date:%Y%m%d}.png"
MINI_BASE = (
    "https://www.inia.uy/sites/default/files/gras/contenidogras/Reportes/"
    "agroclima/AlertaOvinos/WRF_mini"
)
MINI_PATTERN = "Min_{index}.png"
#: Los cinco minis pertenecen a UNA corrida. La regla canónica, demostrada por
#: los reportes históricos del proyecto (28/07 y 29/07), es:
#:
#:     valid_date(Min_N) = batch_run_date + N
#:
#: y NO `hoy + N`. Los rótulos «Hoy | Mañana | Pasado | Hoy+3 | Hoy+4» de la
#: página describen bien un juego FRESCO, pero no deben desplazar un lote viejo
#: que INIA siga sirviendo: al cruzar la medianoche el lote no cambia de fechas.
#: La identidad y la fecha base viven en `batches.py`, persistidas por hash.
MINI_INDEX_IS_RELATIVE_TO_BATCH_RUN_DATE = True

USER_AGENT = "CICOMA-ChillIndex/1.0 (pipeline publico de pariciones; solo lectura)"
TIMEOUT_SECONDS = 30
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 2.0

# --- Caché de borde de la fuente ------------------------------------------
#
# INIA sirve los mapas detrás de Cloudflare. Un GET a la URL canónica puede
# devolver 200 con `CF-Cache-Status: HIT` y un cuerpo que el borde cacheó hace
# DÍAS, aunque el origen ya tenga una corrida más nueva. Verificado el
# 2026-08-07: el mapa del 08/08 llegaba con `Age: 270268` (75,1 h) y grilla
# vacía, mientras el origen tenía un mapa válido sellado ese mismo día.
# `Last-Modified` no delata el problema: describe con exactitud el objeto
# servido, que es justamente el viejo.
#
# UMBRAL. INIA regenera el horizonte completo en un solo lote, una vez por día:
# los sellos observados son 06/08 14:21:31 y 07/08 13:06:21 UTC (≈23 h). Las
# tres respuestas rancias medidas tenían Age de 21,4 h, 48,5 h y 75,1 h, y en
# las tres el origen ya tenía una versión más nueva. 12 h queda por debajo de
# la más ajustada de ellas y por encima de lo que envejece una copia sana entre
# corridas —el pipeline consulta seis veces por día—, así que detecta los tres
# casos reales sin disparar el bypass en cada chequeo. Cuando dispara, el costo
# es UN GET extra.
MAX_EDGE_CACHE_AGE_SECONDS = 12 * 3600

#: Valores de `CF-Cache-Status` que confirman que la respuesta salió del borde
#: y no del origen. `MISS`, `EXPIRED`, `BYPASS`, `DYNAMIC` y `REVALIDATED`
#: implican que se consultó al origen: esos cuerpos son de la corrida vigente.
STALE_CACHE_STATUSES = ("HIT", "STALE", "UPDATING")

#: Parámetro del segundo GET. Cualquier query string basta para que el borde
#: consulte al origen. NUNCA forma parte de la identidad del recurso.
CACHE_BUSTER_PARAM = "cb"

#: Ubicación del establecimiento.
LOCATION: dict[str, str | float] = {
    "name": "CICOMA",
    "latitude": -31.0543558,
    "longitude": -57.2304711,
}

#: Horizonte publicado: hoy y los cuatro días siguientes.
HORIZON_DAYS = 5

#: Paleta oficial de INIA, calibrada contra los mapas de la auditoría.
#: ``CRITICO`` es el nombre interno de INIA; el contrato lo publica como
#: ``MUY_ALTO`` (ver ``RISK_PUBLIC_NAME``).
PALETTE: dict[str, tuple[int, int, int]] = {
    "SIN_RIESGO": (0, 220, 0),
    "BAJO": (0, 200, 200),
    "MEDIO": (0, 160, 255),
    "ALTO": (0, 0, 255),
    "CRITICO": (160, 0, 200),
}

#: Intervalos de Chill Index (kJ/m2/h) declarados en la leyenda del mapa.
RISK_INTERVALS: dict[str, tuple[float | None, float | None]] = {
    "SIN_RIESGO": (None, 900.0),
    "BAJO": (900.0, 1000.0),
    "MEDIO": (1000.0, 1100.0),
    "ALTO": (1100.0, 1200.0),
    "CRITICO": (1200.0, None),
}

#: Nombre público de cada categoría en el contrato.
RISK_PUBLIC_NAME = {
    "SIN_RIESGO": "SIN_RIESGO",
    "BAJO": "BAJO",
    "MEDIO": "MEDIO",
    "ALTO": "ALTO",
    "CRITICO": "MUY_ALTO",
}

CI_UNIT = "kJ/m2/h"

#: Clasificación: ventana de píxeles alrededor de CICOMA y umbral CIELAB.
CLASSIFICATION_WINDOW = 7
LAB_MATCH_THRESHOLD = 22.0

#: WRF_mini: FALLBACK de la misma fecha válida cuando el WRF completo no es
#: interpretable. Un píxel del mini cubre ≈7,7 km contra 1,15 km del completo,
#: así que la ventana es más chica en píxeles pero cubre MÁS territorio: 5×5 en
#: el mini ≈ 38 km de lado. Con esa resolución no se puede exigir unanimidad.
MINI_CLASSIFICATION_WINDOW = 5
#: Mínimo de píxeles de paleta en la ventana para que el mini sea interpretable.
#: Por debajo de esto la categoría queda NO_DETERMINADO: no se inventa.
MINI_MIN_VALID_PIXELS = 8
#: Proporción mínima de la categoría dominante para publicarla sin ambigüedad.
MINI_DOMINANT_SHARE = 0.6

#: Criterio precautorio del mini, documentado y acotado. Ante dos categorías
#: ADYACENTES con presencia cromática real y sin dominante clara, se publica la
#: de MAYOR riesgo: esta herramienta previene mortalidad neonatal y el error de
#: subestimar cuesta más que el de sobreestimar. NO convierte cualquier duda en
#: crítico: exige que las dos categorías estén realmente presentes y sean
#: vecinas en la escala.
MINI_PRECAUTIONARY_ADJACENT = True

#: Orden de la escala, de menor a mayor riesgo. Sirve para decidir adyacencia.
RISK_SCALE = ("SIN_RIESGO", "BAJO", "MEDIO", "ALTO", "CRITICO")

#: Validación de imagen.
WRF_EXPECTED_SIZE: tuple[int, int] = (780, 650)
MIN_PALETTE_COVERAGE_VALID = 0.35
MAX_PALETTE_COVERAGE_NO_DATA = 0.02

#: Vigencia: cuántas horas puede tener el ``Last-Modified`` de un mapa para que
#: la corrida se considere del día. INIA regenera los WRF una vez por día
#: (sello observado ≈13:06 local); 36 h tolera un atraso de la publicación sin
#: aceptar un mapa de anteayer.
MAX_SOURCE_AGE_HOURS = 36.0

# --- Enumeraciones del contrato -------------------------------------------

RISK_CATEGORIES = ("SIN_RIESGO", "BAJO", "MEDIO", "ALTO", "MUY_ALTO", "NO_DETERMINADO")
CONFIDENCE_LEVELS = ("high", "medium", "low", "none")

#: Disponibilidad de la fecha. Distingue dos cosas que antes se confundían:
#:
#: * ``SIN_DATOS``  → el pipeline funcionó bien y **la fuente** no tiene
#:   información utilizable para esa fecha. No es una falla nuestra.
#: * ``ERROR``      → el pipeline **no pudo procesar** la fuente por una falla
#:   técnica: red, HTTP, imagen corrupta, clasificador, validación.
#:
#: Las dos se ven en negro y ninguna es una categoría de riesgo, pero el texto,
#: el estado semántico y el motivo son distintos.
AVAILABILITY_STATUS = ("DISPONIBLE", "SIN_DATOS", "ERROR")
DISPLAY_STATUS = AVAILABILITY_STATUS

#: Motivos por los que la fuente no aporta un pronóstico utilizable. El pipeline
#: funcionó: no hay nada que arreglar de este lado.
REASON_NO_DATA = (
    "MAP_NOT_PUBLISHED",
    "WRF_UNDEFINED_GRID",
    "FORECAST_EXPIRED",
    "SOURCE_DATE_UNVERIFIED",
    "WRF_MINI_ONLY",
)

#: Motivos de falla técnica. Estos sí exigen mirar el pipeline o la red.
REASON_ERROR = (
    "SOURCE_TIMEOUT",
    "SOURCE_HTTP_403",
    "SOURCE_HTTP_404",
    "SOURCE_HTTP_429",
    "SOURCE_HTTP_5XX",
    "CORRUPT_IMAGE",
    "INVALID_DIMENSIONS",
    "CLASSIFICATION_ERROR",
    "CONTRACT_VALIDATION_ERROR",
    "PUBLICATION_ERROR",
)

#: Motivo de una fecha publicada con categoría.
REASON_VALID = "MAP_VALID"

REASON_CODES = (REASON_VALID, *REASON_NO_DATA, *REASON_ERROR)

#: Estado del sistema (NO es el estado de un día).
SYSTEM_STATUS = (
    "ACTUALIZADO",
    "DATOS_PARCIALES",
    "SIN_PRONOSTICO_CONFIABLE",
    "DATOS_PARCIALES_CON_ERRORES",
    "ERROR_DE_FUENTE",
    "ERROR_DE_PIPELINE",
)

_HERE = Path(__file__).parent


def load_calibration() -> dict[str, Any]:
    """Calibración geográfica del WRF completo (marco y extensión del dominio)."""

    return json.loads((_HERE / "config" / "calibration_wrf.json").read_text(encoding="utf-8"))


def load_mini_calibration() -> dict[str, Any]:
    """Calibración geográfica del WRF_mini.

    Es OTRA transformación: misma extensión geográfica que el completo, pero
    117×98 px en vez de 780×650. El píxel de CICOMA en el completo (288, 169)
    ni siquiera existe en el mini.
    """

    return json.loads(
        (_HERE / "config" / "calibration_wrf_mini.json").read_text(encoding="utf-8")
    )
