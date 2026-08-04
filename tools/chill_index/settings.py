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
PIPELINE_VERSION = "1.0.0"
SCHEMA_VERSION = "1.0.0"

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

USER_AGENT = "CICOMA-ChillIndex/1.0 (pipeline publico de pariciones; solo lectura)"
TIMEOUT_SECONDS = 30
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 2.0

#: Ubicación del establecimiento.
LOCATION = {"name": "CICOMA", "latitude": -31.0543558, "longitude": -57.2304711}

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

#: Validación de imagen.
WRF_EXPECTED_SIZE = (780, 650)
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
DISPLAY_STATUS = ("DISPONIBLE", "SIN_DATOS")

#: Motivos técnicos por los que una fecha queda sin dato. El público sólo ve
#: «Sin datos»; el motivo vive en el contrato, el historial y la gestión.
REASON_CODES = (
    "WRF_UNDEFINED_GRID",
    "SOURCE_DATE_UNVERIFIED",
    "MAP_NOT_PUBLISHED",
    "MAP_REJECTED",
    "SOURCE_UNAVAILABLE",
    "FORECAST_EXPIRED",
)

#: Estado del sistema (NO es el estado de un día).
SYSTEM_STATUS = (
    "ACTUALIZADO",
    "DATOS_PARCIALES",
    "SIN_PRONOSTICO_CONFIABLE",
    "FUENTE_NO_DISPONIBLE",
    "ERROR_DE_VALIDACION",
)

_HERE = Path(__file__).parent


def load_calibration() -> dict[str, Any]:
    """Calibración geográfica del WRF completo (marco y extensión del dominio)."""

    return json.loads((_HERE / "config" / "calibration_wrf.json").read_text(encoding="utf-8"))
