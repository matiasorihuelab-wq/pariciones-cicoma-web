"""Pruebas del pipeline Chill Index. Ninguna depende de que INIA esté disponible.

Los fixtures son inmutables: el WRF válido es una copia byte a byte del mapa que
la auditoría archivó el 31/07/2026, y la grilla vacía se construye con el mismo
marco calibrado. Las respuestas HTTP se simulan.
"""

from __future__ import annotations

import io
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from PIL import Image

from tools.chill_index import (
    contract,
    freshness,
    history,
    http_source,
    imaging,
    publisher,
    settings,
)
from tools.chill_index.classifier import classify, inside_domain, latlon_to_pixel
from tools.chill_index.cli import run

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
WRF_VALIDO = FIXTURES / "wrf_valido_20260731.png"
CAL = settings.load_calibration()
AHORA = datetime(2026, 8, 3, 16, 0, tzinfo=UTC)
HOY = date(2026, 8, 3)


# ----------------------------------------------------------- utilidades ---


def _png(size: tuple[int, int], color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _grilla_vacia() -> bytes:
    """WRF con marco y leyenda pero sin colores de paleta: 'Entire Grid Undefined'."""

    image = Image.new("RGB", tuple(settings.WRF_EXPECTED_SIZE), (255, 255, 255))
    pixels = image.load()
    frame = CAL["frame"]
    for x in range(int(frame["x0"]), int(frame["x1"])):
        pixels[x, int(frame["y0"])] = (0, 0, 0)
        pixels[x, int(frame["y1"])] = (0, 0, 0)
    for y in range(int(frame["y0"]), int(frame["y1"])):
        pixels[int(frame["x0"]), y] = (0, 0, 0)
        pixels[int(frame["x1"]), y] = (0, 0, 0)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _mapa_pintado(categoria: str) -> bytes:
    """WRF con toda la grilla del color de una categoría de la leyenda."""

    image = Image.new("RGB", tuple(settings.WRF_EXPECTED_SIZE), (255, 255, 255))
    pixels = image.load()
    frame = CAL["frame"]
    color = settings.PALETTE[categoria]
    for x in range(int(frame["x0"]) + 1, int(frame["x1"])):
        for y in range(int(frame["y0"]) + 1, int(frame["y1"])):
            pixels[x, y] = color
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class _Respuesta:
    def __init__(self, status: int, content: bytes = b"", headers: dict | None = None) -> None:
        self.status_code = status
        self.content = content
        self.headers = headers or {}


class _SesionFalsa:
    """Cliente HTTP simulado: devuelve lo que le indique el mapa de rutas."""

    def __init__(self, rutas: dict[str, object], por_defecto: object | None = None) -> None:
        self.rutas = rutas
        self.por_defecto = por_defecto
        self.pedidos: list[str] = []

    def get(self, url: str, **_: object) -> _Respuesta:
        self.pedidos.append(url)
        valor = next((v for k, v in self.rutas.items() if k in url), self.por_defecto)
        if valor is None:
            return _Respuesta(404)
        if isinstance(valor, Exception):
            raise valor
        assert isinstance(valor, _Respuesta)
        return valor


def _lm(momento: datetime) -> str:
    return momento.strftime("%a, %d %b %Y %H:%M:%S GMT")


# --------------------------------------------------- A · validación de imagen ---


def test_el_wrf_de_la_auditoria_es_valido() -> None:
    """Fixture inmutable: el mapa real del 31/07/2026 archivado por la auditoría."""

    revision = imaging.check_wrf(WRF_VALIDO.read_bytes(), CAL)
    assert revision.status == imaging.VALID
    assert (revision.width, revision.height) == tuple(settings.WRF_EXPECTED_SIZE)
    assert revision.palette_coverage and revision.palette_coverage > 0.35


def test_una_grilla_vacia_no_es_un_mapa_con_datos() -> None:
    revision = imaging.check_wrf(_grilla_vacia(), CAL)
    assert revision.status == imaging.NO_DATA
    assert "Entire Grid Undefined" in revision.reason


def test_un_png_corrupto_se_rechaza() -> None:
    assert imaging.check_wrf(b"esto no es un png", CAL).status == imaging.INVALID_IMAGE


def test_dimensiones_incorrectas_se_rechazan() -> None:
    revision = imaging.check_wrf(_png((100, 100), (0, 200, 200)), CAL)
    assert revision.status == imaging.INVALID_IMAGE
    assert "Dimensiones" in revision.reason


def test_una_paleta_desconocida_no_se_fuerza_a_la_mas_parecida() -> None:
    nombre, _ = imaging.nearest_palette((255, 128, 64))
    assert nombre is None


# ------------------------------------------------------- B · clasificación ---


def test_la_clasificacion_del_mapa_real_es_reproducible() -> None:
    revision = imaging.check_wrf(WRF_VALIDO.read_bytes(), CAL)
    assert revision.image is not None
    primera = classify(revision.image, CAL, lat=-31.0543558, lon=-57.2304711)
    segunda = classify(revision.image, CAL, lat=-31.0543558, lon=-57.2304711)
    assert primera.category == segunda.category
    assert primera.category in settings.RISK_CATEGORIES
    assert primera.category != "NO_DETERMINADO"


@pytest.mark.parametrize(
    ("interna", "publica"),
    [("SIN_RIESGO", "SIN_RIESGO"), ("BAJO", "BAJO"), ("CRITICO", "MUY_ALTO")],
)
def test_cada_color_de_la_leyenda_da_su_categoria(interna: str, publica: str) -> None:
    revision = imaging.check_wrf(_mapa_pintado(interna), CAL)
    assert revision.image is not None
    resultado = classify(revision.image, CAL, lat=-31.0543558, lon=-57.2304711)
    assert resultado.category == publica
    assert resultado.confidence == "high"


def test_una_ubicacion_fuera_del_dominio_no_se_clasifica() -> None:
    assert not inside_domain(CAL, lat=-10.0, lon=-57.0)
    revision = imaging.check_wrf(_mapa_pintado("BAJO"), CAL)
    assert revision.image is not None
    resultado = classify(revision.image, CAL, lat=-10.0, lon=-57.0)
    assert resultado.category is None
    assert resultado.confidence == "none"


def test_cicoma_cae_dentro_del_marco() -> None:
    x, y = latlon_to_pixel(CAL, -31.0543558, -57.2304711)
    assert CAL["frame"]["x0"] < x < CAL["frame"]["x1"]
    assert CAL["frame"]["y0"] < y < CAL["frame"]["y1"]


# ------------------------------------------------------------- C · vigencia ---


def test_la_antigüedad_se_mide_desde_la_fuente_no_desde_la_descarga() -> None:
    modificado = AHORA - timedelta(hours=5)
    veredicto = freshness.evaluate_source(modificado, now=AHORA)
    assert veredicto.verified
    assert veredicto.source_age_hours == 5.0


def test_volver_a_descargar_lo_mismo_no_rejuvenece_el_dato() -> None:
    """El defecto corregido: la antigüedad no se reinicia por una descarga nueva."""

    modificado = AHORA - timedelta(hours=30)
    primera = freshness.evaluate_source(modificado, now=AHORA)
    segunda = freshness.evaluate_source(modificado, now=AHORA + timedelta(hours=2))
    assert primera.source_age_hours == 30.0
    assert segunda.source_age_hours == 32.0


def test_un_archivo_viejo_no_verifica_la_fecha_de_corrida() -> None:
    veredicto = freshness.evaluate_source(AHORA - timedelta(days=4), now=AHORA)
    assert not veredicto.verified
    assert veredicto.reason == "SOURCE_DATE_UNVERIFIED"


def test_sin_last_modified_la_antigüedad_es_desconocida_no_cero() -> None:
    veredicto = freshness.evaluate_source(None, now=AHORA)
    assert not veredicto.verified
    assert veredicto.source_age_hours is None


def test_un_horizonte_vencido_se_detecta() -> None:
    assert freshness.horizon_expired(date(2026, 8, 1), today=HOY)
    assert not freshness.horizon_expired(date(2026, 8, 3), today=HOY)


def test_la_antiguedad_del_ultimo_valido_se_conserva() -> None:
    assert freshness.carry_forward_age("2026-07-28", today=HOY) == 6
    assert freshness.carry_forward_age(None, today=HOY) is None


# ------------------------------------------------------------- D · contrato ---


def test_un_dia_sin_datos_no_lleva_categoria_ni_intervalo() -> None:
    mapa = contract.no_data_map(
        forecast_day=0,
        valid_date="2026-08-03",
        source_url="https://ejemplo/mapa.png",
        reason="WRF_UNDEFINED_GRID",
    )
    assert mapa["risk_category"] == "NO_DETERMINADO"
    assert mapa["display_status"] == "SIN_DATOS"
    assert mapa["ci_min"] is None and mapa["ci_max"] is None
    assert mapa["confidence"] == "none"


def test_un_dia_publicado_lleva_el_intervalo_de_su_leyenda() -> None:
    mapa = contract.risk_map(
        forecast_day=0,
        valid_date="2026-08-03",
        source_url="https://ejemplo/mapa.png",
        sha256="a" * 64,
        last_modified=None,
        source_age_hours=1.0,
        http_status=200,
        category="MEDIO",
        confidence="high",
        evidence_path=None,
    )
    assert (mapa["ci_min"], mapa["ci_max"]) == (1000.0, 1100.0)


def test_el_contrato_rechaza_un_intervalo_que_no_corresponde() -> None:
    payload = _payload_minimo()
    payload["maps"][0]["ci_min"] = 800.0
    with pytest.raises(contract.ContractError, match="no corresponde"):
        contract.validate(payload, today_iso=HOY.isoformat())


def test_el_contrato_rechaza_publicar_sin_hash() -> None:
    payload = _payload_minimo()
    payload["maps"][0]["source_sha256"] = None
    with pytest.raises(contract.ContractError, match="sin hash"):
        contract.validate(payload, today_iso=HOY.isoformat())


def test_el_contrato_rechaza_una_categoria_con_estado_sin_datos() -> None:
    payload = _payload_minimo()
    payload["maps"][0]["display_status"] = "SIN_DATOS"
    with pytest.raises(contract.ContractError, match="sin datos"):
        contract.validate(payload, today_iso=HOY.isoformat())


def test_actualizado_exige_serie_completa_y_vigente() -> None:
    payload = _payload_minimo()
    payload["maps"].append(
        contract.no_data_map(
            forecast_day=1,
            valid_date="2026-08-04",
            source_url="https://ejemplo/otro.png",
            reason="WRF_UNDEFINED_GRID",
        )
    )
    with pytest.raises(contract.ContractError, match="ACTUALIZADO exige"):
        contract.validate(payload, today_iso=HOY.isoformat())


@pytest.mark.parametrize(
    ("disponibles", "esperado"),
    [
        (0, "SIN_PRONOSTICO_CONFIABLE"),
        (1, "DATOS_PARCIALES"),
    ],
)
def test_estado_del_sistema_segun_cobertura(disponibles: int, esperado: str) -> None:
    mapas = []
    for indice in range(3):
        fecha = (HOY + timedelta(days=indice)).isoformat()
        if indice < disponibles:
            mapas.append(
                contract.risk_map(
                    forecast_day=indice,
                    valid_date=fecha,
                    source_url="https://ejemplo/m.png",
                    sha256="b" * 64,
                    last_modified=None,
                    source_age_hours=1.0,
                    http_status=200,
                    category="BAJO",
                    confidence="high",
                    evidence_path=None,
                )
            )
        else:
            mapas.append(
                contract.no_data_map(
                    forecast_day=indice,
                    valid_date=fecha,
                    source_url="https://ejemplo/m.png",
                    reason="WRF_UNDEFINED_GRID",
                )
            )
    assert contract.system_status(mapas, today_iso=HOY.isoformat(), fetch_failed=False) == esperado


def test_fuente_caida_es_estado_de_fuente_no_disponible() -> None:
    mapas = [
        contract.no_data_map(
            forecast_day=0,
            valid_date=HOY.isoformat(),
            source_url="https://ejemplo/m.png",
            reason="SOURCE_UNAVAILABLE",
        )
    ]
    assert (
        contract.system_status(mapas, today_iso=HOY.isoformat(), fetch_failed=True)
        == "FUENTE_NO_DISPONIBLE"
    )


def _payload_minimo() -> dict:
    return {
        "schema_version": settings.SCHEMA_VERSION,
        "pipeline_version": settings.PIPELINE_VERSION,
        "status": "ACTUALIZADO",
        "status_label": contract.STATUS_LABELS["ACTUALIZADO"],
        "status_detail": None,
        "source": settings.SOURCE_NAME,
        "source_page": settings.SOURCE_PAGE,
        "location": dict(settings.LOCATION),
        "timezone": settings.TIMEZONE,
        "run_started_at": AHORA.isoformat(),
        "run_finished_at": AHORA.isoformat(),
        "run_trigger": "test",
        "forecast_run_date": HOY.isoformat(),
        "freshness": {
            "covers_today": True,
            "maps_valid": 1,
            "maps_total": 1,
            "source_age_hours": 1.0,
            "last_valid_forecast_run_date": HOY.isoformat(),
            "last_valid_age_days": 0,
        },
        "model": "WRF",
        "maps": [
            contract.risk_map(
                forecast_day=0,
                valid_date=HOY.isoformat(),
                source_url="https://ejemplo/mapa.png",
                sha256="c" * 64,
                last_modified=None,
                source_age_hours=1.0,
                http_status=200,
                category="MEDIO",
                confidence="high",
                evidence_path=None,
            )
        ],
        "diagnostics": {"wrf_mini": {"policy": "diagnóstico", "observations": []}},
    }


# --------------------------------------------------------- E · publicación ---


def test_la_escritura_es_atomica_y_verifica_el_hash(tmp_path: Path) -> None:
    destino = tmp_path / "data" / "chill_index.json"
    payload = _payload_minimo()
    digest = publisher.write_atomic(destino, payload)
    assert destino.exists()
    assert json.loads(destino.read_text(encoding="utf-8"))["status"] == "ACTUALIZADO"
    assert len(digest) == 64
    assert not list(destino.parent.glob("*.tmp")), "no quedan temporales"


def test_el_hash_de_contenido_ignora_los_sellos_de_la_corrida() -> None:
    uno = _payload_minimo()
    otro = dict(uno)
    otro["run_started_at"] = "2030-01-01T00:00:00+00:00"
    otro["run_trigger"] = "otro"
    assert publisher.payload_hash(uno) == publisher.payload_hash(otro)


def test_la_evidencia_se_guarda_una_sola_vez_por_hash(tmp_path: Path) -> None:
    contenido = _grilla_vacia()
    primero = publisher.store_evidence(tmp_path, day="2026-08-03", sha256="d" * 64, content=contenido)
    segundo = publisher.store_evidence(tmp_path, day="2026-08-03", sha256="d" * 64, content=contenido)
    assert primero == segundo
    assert len(list((tmp_path / "2026-08-03").glob("*.png"))) == 1


# ------------------------------------------------------------ F · historial ---


def test_toda_corrida_deja_registro_aunque_no_haya_novedades(tmp_path: Path) -> None:
    """El defecto corregido: antes el silencio era indistinguible de 'no pasó nada'."""

    destino = tmp_path / "chill_history.jsonl"
    for indice in range(3):
        history.append_run(
            destino,
            history.build_entry(
                run_id=f"r{indice}",
                trigger="cron",
                started_at=AHORA.isoformat(),
                finished_at=AHORA.isoformat(),
                technical_result="OK",
                source_result="SIN_PRONOSTICO_CONFIABLE",
                publication_result="SIN_CAMBIOS",
                forecast_run_date=None,
                new_series=False,
                maps_requested=5,
                maps_downloaded=5,
                maps_valid=0,
                maps_undefined=5,
                maps_rejected=0,
                output_hash="x" * 64,
                previous_output_hash="x" * 64,
            ),
        )
    assert len(history.read_runs(destino)) == 3


def test_el_ultimo_valido_se_recuerda_entre_corridas(tmp_path: Path) -> None:
    destino = tmp_path / "h.jsonl"
    base = dict(
        trigger="cron",
        started_at=AHORA.isoformat(),
        finished_at=AHORA.isoformat(),
        technical_result="OK",
        source_result="OK",
        publication_result="PUBLICADO",
        new_series=True,
        maps_requested=5,
        maps_downloaded=5,
        maps_undefined=0,
        maps_rejected=0,
        output_hash="a" * 64,
        previous_output_hash=None,
    )
    history.append_run(
        destino,
        history.build_entry(run_id="v1", forecast_run_date="2026-07-31", maps_valid=5, **base),
    )
    history.append_run(
        destino,
        history.build_entry(run_id="v2", forecast_run_date=None, maps_valid=0, **base),
    )
    ultima = history.last_valid_forecast(history.read_runs(destino))
    assert ultima is not None and ultima["forecast_run_date"] == "2026-07-31"


# ------------------------------------------------------- G · descarga HTTP ---


@pytest.mark.parametrize("codigo", [403, 429, 500])
def test_un_error_http_no_produce_contenido(codigo: int) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(codigo))
    resultado = http_source.fetch("https://ejemplo/x.png", session=sesion, now=AHORA)
    assert not resultado.ok
    assert resultado.http_status == codigo
    assert resultado.body is None


def test_un_timeout_queda_registrado_como_error() -> None:
    sesion = _SesionFalsa({}, por_defecto=TimeoutError("agotado"))
    resultado = http_source.fetch("https://ejemplo/x.png", session=sesion, now=AHORA)
    assert not resultado.ok
    assert resultado.error and "TimeoutError" in resultado.error


def test_un_200_con_contenido_invalido_sigue_siendo_200() -> None:
    """HTTP 200 no implica mapa: la validación de contenido es aparte."""

    sesion = _SesionFalsa({}, por_defecto=_Respuesta(200, b"basura"))
    resultado = http_source.fetch("https://ejemplo/x.png", session=sesion, now=AHORA)
    assert resultado.ok
    assert imaging.check_wrf(resultado.body or b"", CAL).status == imaging.INVALID_IMAGE


# ------------------------------------------- H · corrida completa simulada ---


def _correr(tmp_path: Path, sesion: _SesionFalsa, **extra: object) -> dict:
    return run(
        output=tmp_path / "data" / "chill_index.json",
        evidence_root=tmp_path / "evidence",
        history_path=tmp_path / "data" / "chill_history.jsonl",
        trigger="test",
        today=HOY,
        now=AHORA,
        session=sesion,
        **extra,  # type: ignore[arg-type]
    )


def test_escenario_real_grilla_vacia_publica_sin_datos(tmp_path: Path) -> None:
    """El caso del 03/08: INIA responde 200 con la grilla vacía en los cinco mapas."""

    sesion = _SesionFalsa(
        {},
        por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion, skip_mini=True)

    assert resumen["status"] == "SIN_PRONOSTICO_CONFIABLE"
    assert resumen["maps_valid"] == 0
    assert resumen["maps_undefined"] == 5
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["display_status"] == "SIN_DATOS" for m in publicado["maps"])
    assert all(m["risk_category"] == "NO_DETERMINADO" for m in publicado["maps"])
    assert all(m["reason"] == "WRF_UNDEFINED_GRID" for m in publicado["maps"])
    assert all(m["ci_min"] is None for m in publicado["maps"])
    assert "SIN_RIESGO" not in json.dumps(publicado["maps"])
    assert publicado["freshness"]["covers_today"] is False
    assert publicado["forecast_run_date"] is None


def test_escenario_completo_publica_categorias(tmp_path: Path) -> None:
    sesion = _SesionFalsa(
        {},
        por_defecto=_Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion, skip_mini=True)
    assert resumen["status"] == "ACTUALIZADO"
    assert resumen["maps_valid"] == 5
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["risk_category"] == "BAJO" for m in publicado["maps"])
    assert publicado["forecast_run_date"] == HOY.isoformat()


def test_un_mapa_valido_pero_viejo_no_se_publica(tmp_path: Path) -> None:
    """Con datos pero con Last-Modified de hace cuatro días: SIN_DATOS."""

    viejo = _lm(AHORA - timedelta(days=4))
    sesion = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _mapa_pintado("ALTO"), {"Last-Modified": viejo})
    )
    resumen = _correr(tmp_path, sesion, skip_mini=True)
    assert resumen["status"] == "SIN_PRONOSTICO_CONFIABLE"
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["reason"] == "SOURCE_DATE_UNVERIFIED" for m in publicado["maps"])


def test_serie_parcial_produce_datos_parciales(tmp_path: Path) -> None:
    hoy_url = http_source.wrf_url(HOY).rsplit("/", 1)[-1]
    sesion = _SesionFalsa(
        {hoy_url: _Respuesta(200, _mapa_pintado("MEDIO"), {"Last-Modified": _lm(AHORA)})},
        por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion, skip_mini=True)
    assert resumen["status"] == "DATOS_PARCIALES"
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    primero, *resto = publicado["maps"]
    assert primero["display_status"] == "DISPONIBLE" and primero["risk_category"] == "MEDIO"
    assert all(m["display_status"] == "SIN_DATOS" for m in resto)


def test_fuente_totalmente_caida(tmp_path: Path) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(503))
    resumen = _correr(tmp_path, sesion, skip_mini=True)
    assert resumen["status"] == "FUENTE_NO_DISPONIBLE"
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["reason"] == "SOURCE_UNAVAILABLE" for m in publicado["maps"])


def test_mapa_no_publicado_da_404(tmp_path: Path) -> None:
    sesion = _SesionFalsa({}, por_defecto=_Respuesta(404))
    resumen = _correr(tmp_path, sesion, skip_mini=True)
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["reason"] == "MAP_NOT_PUBLISHED" for m in publicado["maps"])
    assert resumen["maps_downloaded"] == 0


def test_una_segunda_corrida_identica_es_idempotente(tmp_path: Path) -> None:
    """Sin novedades no se reescribe el archivo, pero sí queda registro."""

    sesion = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)})
    )
    primera = _correr(tmp_path, sesion, skip_mini=True)
    segunda = _correr(tmp_path, sesion, skip_mini=True)

    assert primera["publication"] == "PUBLICADO"
    assert segunda["publication"] == "SIN_CAMBIOS"
    assert primera["output_hash"] == segunda["output_hash"]
    assert len(history.read_runs(tmp_path / "data" / "chill_history.jsonl")) == 2


def test_la_miniatura_nunca_publica_una_categoria(tmp_path: Path) -> None:
    """WRF completo vacío y miniatura con color: el público ve SIN_DATOS."""

    sesion = _SesionFalsa(
        {"WRF_mini": _Respuesta(200, _png((117, 98), (0, 0, 255)), {"Last-Modified": _lm(AHORA)})},
        por_defecto=_Respuesta(200, _grilla_vacia(), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["display_status"] == "SIN_DATOS" for m in publicado["maps"])
    diagnostico = publicado["diagnostics"]["wrf_mini"]
    assert diagnostico["observations"], "la miniatura se observa como evidencia"
    assert "no se usa como fuente autónoma" in diagnostico["policy"].lower()
    assert "WRF_mini" not in publicado["model"]


def test_la_evidencia_de_cada_mapa_queda_archivada(tmp_path: Path) -> None:
    sesion = _SesionFalsa(
        {}, por_defecto=_Respuesta(200, _mapa_pintado("BAJO"), {"Last-Modified": _lm(AHORA)})
    )
    _correr(tmp_path, sesion, skip_mini=True)
    guardadas = list((tmp_path / "evidence").rglob("*.png"))
    assert guardadas, "cada imagen analizada deja una copia inmutable"
    publicado = json.loads((tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8"))
    assert all(m["evidence_path"] for m in publicado["maps"])
