"""Pipeline determinístico del Chill Index de CICOMA.

Produce el contrato publicado en GitHub Pages a partir de los mapas WRF de
INIA-GRAS. Sin Zapia, sin Google Drive y sin IA generativa: la clasificación es
una comparación de color en CIELAB contra la paleta calibrada, reproducible a
partir del hash de la imagen y del commit de este código.
"""

from . import settings

__all__ = ["settings"]
__version__ = settings.PIPELINE_VERSION
