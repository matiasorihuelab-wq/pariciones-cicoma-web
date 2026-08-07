"""Protección contra la caché de borde rancia de la fuente.

El 2026-08-07 se comprobó que INIA, detrás de Cloudflare, puede responder al GET
canónico con `200 OK`, `Last-Modified` coherente y un cuerpo que el borde cacheó
75 horas antes, mientras el origen ya tenía la corrida del día. Como el cuerpo
viejo del 08/08 era una grilla vacía, el tablero publicó «SIN DATOS» para una
fecha que sí tenía pronóstico; y los mapas del 07/08 y del 10/08 se publicaron
con categorías de una corrida de tres días atrás.

Estas pruebas fijan la corrección: medir la antigüedad de borde, repetir UNA vez
con bypass cuando la respuesta es rancia, y dejar toda la cadena en la evidencia.
Ninguna depende de que INIA esté disponible.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

from tools.chill_index import http_source, publisher, settings
from tools.chill_index.cli import run
from tools.chill_index.tests.test_pipeline import (
    AHORA,
    HOY,
    _grilla_vacia,
    _lm,
    _mapa_pintado,
    _Respuesta,
)

UMBRAL = settings.MAX_EDGE_CACHE_AGE_SECONDS
VIEJO = UMBRAL + 3600  # una hora pasada del umbral
MUY_VIEJO = 270268  # el Age real medido el 2026-08-07 para el mapa del 08/08


def _es_bypass(url: str) -> bool:
    return f"{settings.CACHE_BUSTER_PARAM}=" in url


class _SesionCDN:
    """Cliente simulado que distingue el GET canónico del GET con bypass.

    `canonico` es lo que devuelve el borde; `fresco` lo que devuelve el origen
    cuando se lo saltea. Si `fresco` es ``None``, el bypass fracasa.
    """

    def __init__(
        self,
        canonico: _Respuesta,
        fresco: _Respuesta | None = None,
        *,
        bypass_status: int = 404,
    ) -> None:
        self.canonico = canonico
        self.fresco = fresco
        self.bypass_status = bypass_status
        self.pedidos: list[str] = []

    def get(self, url: str, **_: object) -> _Respuesta:
        self.pedidos.append(url)
        if not _es_bypass(url):
            return self.canonico
        if self.fresco is None:
            return _Respuesta(self.bypass_status)
        return self.fresco

    # --- ayudas de lectura ---
    @property
    def canonicos(self) -> list[str]:
        return [u for u in self.pedidos if not _es_bypass(u)]

    @property
    def bypasses(self) -> list[str]:
        return [u for u in self.pedidos if _es_bypass(u)]


def _borde(age: int | None, *, cuerpo: bytes, estado: str | None = "HIT") -> _Respuesta:
    headers: dict[str, str] = {"Last-Modified": _lm(AHORA)}
    if age is not None:
        headers["Age"] = str(age)
    if estado is not None:
        headers["CF-Cache-Status"] = estado
    return _Respuesta(200, cuerpo, headers)


def _origen(cuerpo: bytes) -> _Respuesta:
    return _Respuesta(200, cuerpo, {"Last-Modified": _lm(AHORA), "CF-Cache-Status": "MISS"})


def _correr(tmp_path: Path, sesion: Any, *, skip_mini: bool = True, now: Any = AHORA) -> dict:
    return run(
        output=tmp_path / "data" / "chill_index.json",
        evidence_root=tmp_path / "evidence",
        history_path=tmp_path / "data" / "chill_history.jsonl",
        batches_path=tmp_path / "data" / "mini_batches.jsonl",
        trigger="test",
        today=HOY,
        now=now,
        session=sesion,
        skip_mini=skip_mini,
    )


def _publicado(tmp_path: Path) -> dict[str, Any]:
    return json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))


# ------------------------------------------- A · el caso normal no cambia ---


def test_A1_una_respuesta_fresca_no_dispara_bypass() -> None:
    sesion = _SesionCDN(_borde(60, cuerpo=_mapa_pintado("MEDIO"), estado="HIT"))
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260803.png", session=sesion)

    assert resultado.ok
    assert sesion.bypasses == [], "no se sale a buscar lo que ya está vigente"
    assert resultado.cache_bypassed is False
    assert resultado.stale_reason is None
    assert resultado.age_seconds == 60
    assert resultado.cache_status == "HIT"


def test_A2_sin_encabezados_de_cache_se_comporta_como_antes() -> None:
    """Una fuente que no declara caché no puede quedar bloqueada por esta regla."""

    sesion = _SesionCDN(_Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}))
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260803.png", session=sesion)

    assert resultado.ok
    assert sesion.bypasses == []
    assert resultado.age_seconds is None
    assert resultado.stale_reason is None


def test_A3_un_miss_viejo_viene_del_origen_y_no_se_repite() -> None:
    """`MISS` significa que se consultó al origen: el objeto es el vigente."""

    sesion = _SesionCDN(_borde(MUY_VIEJO, cuerpo=_mapa_pintado("ALTO"), estado="MISS"))
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260803.png", session=sesion)

    assert sesion.bypasses == []
    assert resultado.stale_reason is None


# ------------------------------------ B · borde rancio → exactamente un bypass ---


def test_B1_hit_por_encima_del_umbral_dispara_un_solo_bypass() -> None:
    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("ALTO")),
    )
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260808.png", session=sesion)

    assert len(sesion.canonicos) == 1, "el primer GET es siempre a la URL canónica"
    assert len(sesion.bypasses) == 1, "exactamente UN reintento, no una tormenta"
    assert resultado.cache_bypassed is True
    assert "Age=270268" in (resultado.stale_reason or "")


def test_B2_usa_el_cuerpo_del_segundo_get() -> None:
    fresco = _mapa_pintado("ALTO")
    sesion = _SesionCDN(_borde(VIEJO, cuerpo=_grilla_vacia()), _origen(fresco))
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260808.png", session=sesion)

    assert resultado.body == fresco
    assert resultado.canonical_sha256 != resultado.bypass_sha256
    assert resultado.sha256 == resultado.bypass_sha256


def test_B3_el_umbral_se_lee_de_configuracion_no_del_codigo() -> None:
    """La política vive en `settings`; `stale_reason` sólo la aplica."""

    assert http_source.stale_reason("HIT", UMBRAL) is None, "en el umbral todavía no es rancio"
    assert http_source.stale_reason("HIT", UMBRAL + 1) is not None
    assert http_source.stale_reason("HIT", None) is None
    assert http_source.stale_reason("MISS", MUY_VIEJO) is None
    assert http_source.stale_reason("EXPIRED", MUY_VIEJO) is None
    assert http_source.stale_reason("REVALIDATED", MUY_VIEJO) is None


def test_B4_la_url_canonica_no_lleva_el_parametro() -> None:
    canonica = "https://ejemplo/Chill_wrf20260808.png"
    sesion = _SesionCDN(_borde(VIEJO, cuerpo=_grilla_vacia()), _origen(_mapa_pintado("BAJO")))
    resultado = http_source.fetch(canonica, session=sesion)

    assert resultado.source_url == canonica, "la identidad del recurso no cambia"
    assert settings.CACHE_BUSTER_PARAM not in resultado.source_url
    assert resultado.bypass_url is not None
    assert resultado.bypass_url.startswith(canonica + "?")


# ------------------------------------- C · el clasificador usa el cuerpo fresco ---


def test_C_el_pipeline_publica_la_categoria_del_cuerpo_fresco(tmp_path: Path) -> None:
    """El caso real: el borde da grilla vacía, el origen da un mapa válido."""

    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("ALTO")),
    )
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    assert all(m["availability_status"] == "DISPONIBLE" for m in publicado["maps"])
    assert all(m["risk_category"] == "ALTO" for m in publicado["maps"])
    assert all(m["reason_code"] != "WRF_UNDEFINED_GRID" for m in publicado["maps"])


# ------------------------------------------- D · si el bypass también falla ---
#
# REGLA (responsable, 2026-08-07): un cuerpo identificado como RANCIO cuyo
# bypass falló NO es elegible como pronóstico vigente. Se conserva como
# EVIDENCIA —hash, encabezados, motivo—, nunca como categoría publicada. Y no
# se intenta resolverlo con evidencia histórica: ese mecanismo está diferido.


def test_D1_rancio_mas_bypass_fallido_publica_sin_datos(tmp_path: Path) -> None:
    sesion = _SesionCDN(_borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"), None)
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    for mapa in publicado["maps"]:
        assert mapa["availability_status"] == "SIN_DATOS"
        assert mapa["display_status"] == "SIN_DATOS"
        assert mapa["risk_category"] == "NO_DETERMINADO"
        assert mapa["reason_code"] == "SOURCE_DATE_UNVERIFIED"
        assert mapa["ci_min"] is None and mapa["ci_max"] is None


def test_D2_el_cuerpo_rancio_es_evidencia_pero_no_pronostico() -> None:
    """La distinción exacta: A (evidencia) permitido, B (pronóstico) prohibido."""

    canonico = _grilla_vacia()
    sesion = _SesionCDN(_borde(VIEJO, cuerpo=canonico), None)
    resultado = http_source.fetch("https://ejemplo/Chill_wrf20260808.png", session=sesion)

    # B — prohibido: el resultado no ofrece ningún cuerpo clasificable.
    assert not resultado.ok
    assert resultado.body is None
    assert resultado.sha256 is None
    assert "STALE_CACHE_UNRESOLVED" in (resultado.error or "")
    # A — permitido: la evidencia conserva la respuesta rancia y explica todo.
    evidencia = resultado.evidence()
    assert evidencia["canonical_sha256"] is not None, "el hash del cuerpo rancio se conserva"
    assert evidencia["age_seconds"] == VIEJO
    assert evidencia["cache_status"] == "HIT"
    assert evidencia["last_modified"] is not None
    assert evidencia["stale_reason"] is not None
    assert evidencia["cache_bypassed"] is True
    assert evidencia["bypass_error"] is not None, "queda explicado que el bypass falló"


def test_D3_un_critico_rancio_no_llega_al_contrato(tmp_path: Path) -> None:
    """Control negativo: el caso que las grillas vacías no pueden detectar.

    El cuerpo rancio es un mapa VÁLIDO pintado de CRITICO. Si la regla fallara,
    el pipeline lo clasificaría y publicaría «Crítico» con un pronóstico de
    hace tres días: una falsa alerta de frío. Debe quedar SIN_DATOS.
    """

    sesion = _SesionCDN(_borde(MUY_VIEJO, cuerpo=_mapa_pintado("CRITICO"), estado="HIT"), None)
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    categorias = {m["risk_category"] for m in publicado["maps"]}
    assert categorias == {"NO_DETERMINADO"}
    assert "MUY_ALTO" not in categorias, "el CRÍTICO rancio no puede publicarse como vigente"
    for mapa in publicado["maps"]:
        assert mapa["availability_status"] == "SIN_DATOS"
        assert mapa["reason_code"] == "SOURCE_DATE_UNVERIFIED"
    # Y tampoco se rescató con evidencia histórica: ese mecanismo está diferido.
    texto = json.dumps(publicado, ensure_ascii=False)
    assert "MUY_ALTO" not in texto


def test_D4_nunca_se_inventa_una_categoria(tmp_path: Path) -> None:
    sesion = _SesionCDN(_borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"), None)
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    categorias = {m["risk_category"] for m in publicado["maps"]}
    assert categorias == {"NO_DETERMINADO"}
    assert "SIN_RIESGO" not in categorias, "la ausencia de dato no es ausencia de riesgo"


# ---------------------------------------------------------- E · evidencia ---


def test_E1_la_evidencia_reconstruye_la_cadena_completa() -> None:
    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("ALTO")),
    )
    evidencia = http_source.fetch("https://ejemplo/Chill_wrf20260808.png", session=sesion).evidence()

    # El veredicto canónico es el que explica la decisión y no se pisa; el del
    # bypass viaja aparte. Con los dos se reconstruye la cadena entera.
    assert evidencia["cache_status"] == "HIT"
    assert evidencia["age_seconds"] == MUY_VIEJO
    assert evidencia["bypass_cache_status"] == "MISS"
    assert evidencia["cache_bypassed"] is True
    assert evidencia["stale_reason"] and "270268" in evidencia["stale_reason"]
    assert evidencia["canonical_sha256"] and evidencia["bypass_sha256"]
    assert evidencia["canonical_sha256"] != evidencia["bypass_sha256"]
    assert evidencia["sha256"] == evidencia["bypass_sha256"]
    assert evidencia["bypass_url"] and settings.CACHE_BUSTER_PARAM in evidencia["bypass_url"]
    assert evidencia["source_url"].endswith("Chill_wrf20260808.png")


def test_E2_una_descarga_normal_tambien_registra_la_antiguedad() -> None:
    """Sin esto el problema fue invisible tres días: todo eran 200 OK."""

    sesion = _SesionCDN(_borde(120, cuerpo=_mapa_pintado("BAJO"), estado="HIT"))
    evidencia = http_source.fetch("https://ejemplo/Chill_wrf20260803.png", session=sesion).evidence()

    assert evidencia["age_seconds"] == 120
    assert evidencia["cache_status"] == "HIT"
    assert evidencia["cache_bypassed"] is False
    assert evidencia["bypass_url"] is None


def test_E3_la_evidencia_del_contrato_publica_los_campos_nuevos(tmp_path: Path) -> None:
    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("MEDIO")),
    )
    _correr(tmp_path, sesion)
    http = _publicado(tmp_path)["diagnostics"]["http"]

    assert http, "el diagnóstico registra cada consulta"
    for registro in http:
        assert registro["age_seconds"] == MUY_VIEJO
        assert registro["cache_bypassed"] is True
        assert registro["canonical_sha256"] != registro["bypass_sha256"]


# -------------------------------------------------------- F · idempotencia ---


def _correr_con_bypass(destino: Path, momento: Any, categoria: str = "ALTO") -> dict[str, Any]:
    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado(categoria)),
    )
    return _correr(destino, sesion, now=momento)


def test_F1_el_parametro_variable_no_entra_en_el_hash(tmp_path: Path) -> None:
    """Dos corridas con distinto `cb` y el mismo cuerpo: el contrato no cambia.

    Las dos escriben en el MISMO destino, como en producción. Si el parámetro
    se colara en la identidad del recurso, cada corrida reescribiría el archivo
    y dejaría un commit sin información nueva.
    """

    _correr_con_bypass(tmp_path, AHORA)
    primero = _publicado(tmp_path)
    resumen = _correr_con_bypass(tmp_path, AHORA + timedelta(hours=3))
    segundo = _publicado(tmp_path)

    assert publisher.payload_hash(primero) == publisher.payload_hash(segundo)
    assert resumen["content_changed"] is False, "una corrida sin novedad no reescribe nada"


def test_F2_el_bypass_no_deja_rastro_en_la_parte_estable_del_contrato(tmp_path: Path) -> None:
    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("ALTO")),
    )
    _correr(tmp_path, sesion)
    publicado = _publicado(tmp_path)

    # Los mapas guardan la URL canónica, nunca la del bypass.
    for mapa in publicado["maps"]:
        assert settings.CACHE_BUSTER_PARAM + "=" not in mapa["source_url"]
    # Y el parámetro sólo vive donde el hash no mira.
    estable = json.dumps(publisher._stable_view(publicado), ensure_ascii=False, sort_keys=True)
    assert settings.CACHE_BUSTER_PARAM + "=" not in estable


def test_F3_dos_cuerpos_distintos_si_cambian_el_hash(tmp_path: Path) -> None:
    """El control de que F1 no pasa por congelar el hash.

    Mismo destino y misma mecánica que F1: lo único que cambia es el pronóstico
    que devuelve el origen.
    """

    _correr_con_bypass(tmp_path, AHORA, "ALTO")
    primero = publisher.payload_hash(_publicado(tmp_path))
    resumen = _correr_con_bypass(tmp_path, AHORA + timedelta(hours=3), "BAJO")
    segundo = publisher.payload_hash(_publicado(tmp_path))

    assert primero != segundo
    assert resumen["content_changed"] is True, "un pronóstico nuevo sí tiene que publicarse"


# ------------------------------------------------------------ G · WRF_mini ---


def test_G1_las_miniaturas_tienen_la_misma_proteccion() -> None:
    """El respaldo no sirve de nada si viene de la misma caché rancia.

    El 2026-08-07 el lote mini también llegó rancio —los cinco miembros con
    sello del 04/08— y por eso no pudo rescatar al 08/08.
    """

    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=b"\x89PNG\r\n\x1a\nviejo", estado="HIT"),
        _origen(b"\x89PNG\r\n\x1a\nfresco"),
    )
    resultado = http_source.fetch(http_source.mini_url(3), session=sesion)

    assert len(sesion.bypasses) == 1
    assert resultado.cache_bypassed is True
    assert resultado.body == b"\x89PNG\r\n\x1a\nfresco"


def test_G2_el_descubrimiento_de_lotes_consulta_el_origen(tmp_path: Path) -> None:
    """Con `skip_mini=False` los cinco Min_N pasan por la misma protección."""

    sesion = _SesionCDN(
        _borde(MUY_VIEJO, cuerpo=_grilla_vacia(), estado="HIT"),
        _origen(_mapa_pintado("MEDIO")),
    )
    _correr(tmp_path, sesion, skip_mini=False)

    minis = [u for u in sesion.bypasses if "Min_" in u]
    assert len(minis) == settings.HORIZON_DAYS, "cada miniatura se revalida una vez"
