"""«Sin datos» frente a «Error»: dos estados distintos que comparten el negro.

La distinción de fondo:

* ``SIN_DATOS`` — el pipeline funcionó y **la fuente** no tiene información
  utilizable para esa fecha. No hay nada que arreglar de este lado.
* ``ERROR`` — el pipeline **no pudo procesar** la fuente: red, HTTP, imagen
  corrupta, clasificador. Acá sí hay algo que mirar.

Ninguno de los dos es una categoría de riesgo, y en ningún caso se conserva el
valor de la corrida anterior.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from tools.chill_index import http_source
from tools.chill_index.tests.test_pipeline import (
    AHORA,
    HOY,
    _grilla_vacia,
    _lm,
    _mapa_pintado,
    _png,
    _Respuesta,
    _SesionFalsa,
)
from tools.chill_index.cli import run


def _correr(tmp_path: Path, sesion: _SesionFalsa) -> dict[str, Any]:
    return run(
        output=tmp_path / "data" / "chill_index.json",
        evidence_root=tmp_path / "evidence",
        history_path=tmp_path / "data" / "chill_history.jsonl",
        trigger="test",
        today=HOY,
        now=AHORA,
        session=sesion,
        skip_mini=True,
    )


def _publicado(tmp_path: Path) -> dict[str, Any]:
    return json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))


def _sesion_por_fecha(por_dia: dict[int, object], defecto: object) -> _SesionFalsa:
    """Sesión que responde distinto según el día del horizonte."""

    rutas: dict[str, object] = {}
    for offset, respuesta in por_dia.items():
        archivo = http_source.wrf_url(HOY + timedelta(days=offset)).rsplit("/", 1)[-1]
        rutas[archivo] = respuesta
    return _SesionFalsa(rutas, por_defecto=defecto)


# ------------------------------------------------ 1-3 · cobertura parcial ---


def test_un_dia_valido_y_cuatro_sin_datos(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {0: _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    assert resumen["status"] == "DATOS_PARCIALES"
    assert len(publicado["maps"]) == 5, "el contrato siempre trae el horizonte completo"
    assert publicado["maps"][0]["availability_status"] == "DISPONIBLE"
    assert all(m["availability_status"] == "SIN_DATOS" for m in publicado["maps"][1:])


def test_cuatro_validos_y_uno_sin_datos(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {4: _Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _mapa_pintado("MEDIO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    assert resumen["status"] == "DATOS_PARCIALES"
    assert sum(m["availability_status"] == "DISPONIBLE" for m in publicado["maps"]) == 4
    assert publicado["maps"][4]["availability_status"] == "SIN_DATOS"


def test_todos_los_dias_sin_datos_no_es_un_error(tmp_path: Path) -> None:
    """Una corrida correcta contra grillas vacías no es una falla del pipeline."""

    sesion = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)})
    )
    resumen = _correr(tmp_path, sesion)

    assert resumen["status"] == "SIN_PRONOSTICO_CONFIABLE"
    assert all(m["availability_status"] == "SIN_DATOS" for m in _publicado(tmp_path)["maps"])


# ---------------------------------------------------- 4-6 · fallas técnicas ---


def test_un_dia_con_timeout_es_error_no_sin_datos(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {2: TimeoutError("se agotó el tiempo")},
        _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    fallado = _publicado(tmp_path)["maps"][2]

    assert fallado["availability_status"] == "ERROR"
    assert fallado["reason_code"] == "SOURCE_TIMEOUT"
    assert fallado["risk_category"] == "NO_DETERMINADO"
    assert resumen["status"] == "DATOS_PARCIALES_CON_ERRORES"


def test_un_dia_con_404_es_sin_datos_no_error(tmp_path: Path) -> None:
    """INIA contestó bien: todavía no publicó ese mapa. No es una falla nuestra."""

    sesion = _sesion_por_fecha(
        {3: _Respuesta(404)},
        _Respuesta(200, _mapa_pintado("ALTO"), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    fallado = _publicado(tmp_path)["maps"][3]

    assert fallado["availability_status"] == "SIN_DATOS"
    assert fallado["reason_code"] == "MAP_NOT_PUBLISHED"


@pytest.mark.parametrize(
    ("codigo", "motivo"),
    [(403, "SOURCE_HTTP_403"), (429, "SOURCE_HTTP_429"), (503, "SOURCE_HTTP_5XX")],
)
def test_cada_codigo_http_tiene_su_motivo(tmp_path: Path, codigo: int, motivo: str) -> None:
    sesion = _sesion_por_fecha(
        {1: _Respuesta(codigo)},
        _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    fallado = _publicado(tmp_path)["maps"][1]

    assert fallado["availability_status"] == "ERROR"
    assert fallado["reason_code"] == motivo


def test_un_dia_con_imagen_corrupta_es_error(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {1: _Respuesta(200, b"esto no es un png", {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    fallado = _publicado(tmp_path)["maps"][1]

    assert fallado["availability_status"] == "ERROR"
    assert fallado["reason_code"] == "CORRUPT_IMAGE"


def test_dimensiones_invalidas_tienen_su_propio_motivo(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {1: _Respuesta(200, _png((100, 100), (0, 200, 200)), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    assert _publicado(tmp_path)["maps"][1]["reason_code"] == "INVALID_DIMENSIONS"


# ------------------------------------------------------------ 7 · mezcla ---


def test_mezcla_de_riesgo_sin_datos_y_error(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {
            1: _Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)}),
            2: _Respuesta(503),
        },
        _Respuesta(200, _mapa_pintado("MEDIO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    estados = [m["availability_status"] for m in _publicado(tmp_path)["maps"]]

    assert estados == ["DISPONIBLE", "SIN_DATOS", "ERROR", "DISPONIBLE", "DISPONIBLE"]
    assert resumen["status"] == "DATOS_PARCIALES_CON_ERRORES"


# ------------------------------------- 8-9 · no se conserva el valor viejo ---


def test_la_corrida_nueva_reemplaza_el_riesgo_viejo_por_sin_datos(tmp_path: Path) -> None:
    con_datos = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _mapa_pintado("ALTO"), {"Last-Modified": _lm(AHORA)})
    )
    _correr(tmp_path, con_datos)
    assert all(m["risk_category"] == "ALTO" for m in _publicado(tmp_path)["maps"])

    sin_datos = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)})
    )
    _correr(tmp_path, sin_datos)
    publicado = _publicado(tmp_path)

    assert all(m["availability_status"] == "SIN_DATOS" for m in publicado["maps"])
    assert "ALTO" not in json.dumps(publicado["maps"]), "no queda rastro del riesgo anterior"


def test_la_corrida_nueva_reemplaza_el_riesgo_viejo_por_error(tmp_path: Path) -> None:
    con_datos = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _mapa_pintado("CRITICO"), {"Last-Modified": _lm(AHORA)})
    )
    _correr(tmp_path, con_datos)

    caida = _SesionFalsa({}, por_defecto=_Respuesta(503))
    _correr(tmp_path, caida)
    publicado = _publicado(tmp_path)

    assert all(m["availability_status"] == "ERROR" for m in publicado["maps"])
    assert "MUY_ALTO" not in json.dumps(publicado["maps"])  # nombre publico de CRITICO


# --------------------------------- 10-11 · el horizonte se publica entero ---


def test_la_ausencia_de_un_dia_no_bloquea_la_publicacion(tmp_path: Path) -> None:
    sesion = _sesion_por_fecha(
        {0: TimeoutError("caída"), 3: _Respuesta(404)},
        _Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    assert resumen["publication"] == "PUBLICADO"
    assert len(publicado["maps"]) == 5
    assert sum(m["availability_status"] == "DISPONIBLE" for m in publicado["maps"]) == 3


def test_el_contrato_siempre_trae_las_fechas_del_horizonte(tmp_path: Path) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(503))
    _correr(tmp_path, sesion)
    fechas = [m["valid_date"] for m in _publicado(tmp_path)["maps"]]

    assert fechas == [(HOY + timedelta(days=i)).isoformat() for i in range(5)]


# ------------------------------------------- 14 · nunca un riesgo inventado ---


def test_ningun_error_se_representa_como_categoria_de_riesgo(tmp_path: Path) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(403))
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    for mapa in publicado["maps"]:
        assert mapa["risk_category"] == "NO_DETERMINADO"
        assert mapa["ci_min"] is None and mapa["ci_max"] is None
        assert mapa["confidence"] == "none"
    assert "SIN_RIESGO" not in json.dumps(publicado["maps"])


# ------------------------------------------------------------- historial ---


def test_cada_fecha_registra_su_trazabilidad(tmp_path: Path) -> None:
    sesion = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)})
    )
    _correr(tmp_path, sesion)
    for mapa in _publicado(tmp_path)["maps"]:
        for campo in (
            "valid_date",
            "availability_status",
            "risk_category",
            "reason_code",
            "source_url",
            "source_sha256",
            "source_last_modified",
            "checked_at",
        ):
            assert campo in mapa, f"falta {campo} en la trazabilidad"


def test_todos_los_dias_con_error_de_fuente(tmp_path: Path) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(429))
    assert _correr(tmp_path, sesion)["status"] == "ERROR_DE_FUENTE"


def test_todos_los_dias_con_error_del_pipeline(tmp_path: Path) -> None:
    """Imagen ilegible en todas las fechas: el problema es de este lado."""

    sesion = _SesionFalsa({}, por_defecto=_Respuesta(200, b"basura", {"Last-Modified": _lm(AHORA)}))
    assert _correr(tmp_path, sesion)["status"] == "ERROR_DE_PIPELINE"
