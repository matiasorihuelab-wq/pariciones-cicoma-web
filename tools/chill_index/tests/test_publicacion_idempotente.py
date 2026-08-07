"""Cuándo el pipeline reescribe el contrato, y cuándo no debe hacerlo.

Regresión encontrada el 2026-08-07. `publisher.payload_hash` promete ignorar
«lo que cambia con el reloj», pero `checked_at` —agregado al contrato en
`347588b`— sí contaba para el hash. Consecuencia: **toda** corrida reescribía el
archivo y dejaba un commit sin información nueva. Se verificó sobre dos corridas
productivas consecutivas (`8aeec82` → `98710d4`, 07/08 00:43 y 01:04 UTC) cuyo
único cambio eran sellos de tiempo y `elapsed_ms`.

La corrección tiene dos mitades, y las dos importan:

* el hash vuelve a ser sólo de contenido → corridas seguidas con el mismo
  pronóstico no publican;
* al cruzar la medianoche el contrato se reescribe solo, porque el horizonte
  son cinco fechas contadas desde hoy y los cinco `valid_date` cambian. Por eso
  «última verificación» no necesita un refresco forzado: no puede quedar más de
  un día atrasada.
"""

from __future__ import annotations

import io
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from PIL import Image

from tools.chill_index import publisher, settings
from tools.chill_index.cli import run

AHORA = datetime(2026, 8, 3, 16, 0, tzinfo=UTC)
HOY = date(2026, 8, 3)


class _Respuesta:
    def __init__(
        self, status: int, content: bytes = b"", headers: dict | None = None
    ) -> None:
        self.status_code = status
        self.content = content
        self.headers = headers or {}


class _Sesion:
    def __init__(self, cuerpo: bytes) -> None:
        self.cuerpo = cuerpo

    def get(self, _url: str, **_kw: object) -> _Respuesta:
        return _Respuesta(
            200,
            self.cuerpo,
            {"Last-Modified": AHORA.strftime("%a, %d %b %Y %H:%M:%S GMT")},
        )


def _wrf(categoria: str) -> bytes:
    cal = settings.load_calibration()
    image = Image.new("RGB", settings.WRF_EXPECTED_SIZE, (255, 255, 255))
    pixels = image.load()
    assert pixels is not None
    marco = cal["frame"]
    for x in range(int(marco["x0"]) + 1, int(marco["x1"])):
        for y in range(int(marco["y0"]) + 1, int(marco["y1"])):
            pixels[x, y] = settings.PALETTE[categoria]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _correr(tmp_path: Path, sesion: object, *, ahora: datetime, hoy: date) -> dict:
    return run(
        output=tmp_path / "data" / "chill_index.json",
        evidence_root=tmp_path / "evidence",
        history_path=tmp_path / "data" / "chill_history.jsonl",
        batches_path=tmp_path / "data" / "mini_batches.jsonl",
        trigger="test",
        today=hoy,
        now=ahora,
        session=sesion,
        skip_mini=True,
    )


def test_los_sellos_de_reloj_no_cuentan_como_contenido() -> None:
    """La prueba unitaria del defecto: dos contratos que sólo difieren en cuándo
    se miró tienen que tener el MISMO hash de contenido."""

    base = {
        "status": "ACTUALIZADO",
        "freshness": {
            "maps_valid": 5,
            "latest_source_seen": "2026-08-03T16:00:00+00:00",
        },
        "maps": [
            {
                "valid_date": "2026-08-03",
                "risk_category": "MEDIO",
                "source_sha256": "abc",
                "checked_at": "2026-08-03T16:00:00+00:00",
                "source_age_hours": 2.0,
            }
        ],
    }
    otro = json.loads(json.dumps(base))
    otro["freshness"]["latest_source_seen"] = "2026-08-03T22:30:00+00:00"
    otro["maps"][0]["checked_at"] = "2026-08-03T22:30:00+00:00"
    otro["maps"][0]["source_age_hours"] = 8.5

    assert publisher.payload_hash(base) == publisher.payload_hash(otro)

    # Y lo que sí es contenido sigue cambiando el hash.
    distinto = json.loads(json.dumps(base))
    distinto["maps"][0]["risk_category"] = "ALTO"
    assert publisher.payload_hash(base) != publisher.payload_hash(distinto)


def test_dos_corridas_seguidas_del_mismo_dia_no_publican_dos_veces(
    tmp_path: Path,
) -> None:
    """El caso de producción: seis oportunidades diarias no son seis commits."""

    sesion = _Sesion(_wrf("MEDIO"))
    primera = _correr(tmp_path, sesion, ahora=AHORA, hoy=HOY)
    segunda = _correr(tmp_path, sesion, ahora=AHORA + timedelta(hours=3), hoy=HOY)
    tercera = _correr(tmp_path, sesion, ahora=AHORA + timedelta(hours=6), hoy=HOY)

    assert primera["publication"] == "PUBLICADO"
    assert segunda["publication"] == "SIN_CAMBIOS"
    assert tercera["publication"] == "SIN_CAMBIOS"
    assert segunda["output_hash"] == primera["output_hash"]

    # El historial sí registra las tres: no publicar no es no haber corrido.
    historial = [
        json.loads(linea)
        for linea in (tmp_path / "data" / "chill_history.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if linea.strip()
    ]
    assert len(historial) == 3
    assert [e["publication_result"] for e in historial] == [
        "PUBLICADO",
        "SIN_CAMBIOS",
        "SIN_CAMBIOS",
    ]


def test_cruzar_el_dia_reescribe_el_contrato_y_refresca_el_sello(
    tmp_path: Path,
) -> None:
    """«Última verificación» no puede envejecer más de un día, sin código extra.

    Es la otra mitad de la corrección: si el archivo publicado siguiera diciendo
    que la última verificación fue ayer, el productor leería que el sistema dejó
    de mirar la fuente —el error simétrico del que originó la fase—. Acá se
    demuestra que el horizonte móvil ya lo garantiza: al cambiar el día cambian
    los cinco `valid_date`, y eso SÍ es contenido.
    """

    sesion = _Sesion(_wrf("MEDIO"))
    _correr(tmp_path, sesion, ahora=AHORA, hoy=HOY)
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    sello_inicial = publicado["freshness"]["latest_source_seen"]
    fechas_iniciales = [m["valid_date"] for m in publicado["maps"]]

    resultado = _correr(
        tmp_path, sesion, ahora=AHORA + timedelta(days=1), hoy=HOY + timedelta(days=1)
    )
    assert resultado["publication"] == "PUBLICADO"

    republicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    assert republicado["freshness"]["latest_source_seen"] != sello_inicial
    assert republicado["freshness"]["latest_source_seen"].startswith("2026-08-04")
    assert [m["valid_date"] for m in republicado["maps"]] != fechas_iniciales
    # El pronóstico de cada día es el mismo color: lo que se movió es el horizonte.
    assert {m["risk_category"] for m in republicado["maps"]} == {"MEDIO"}


def test_un_pronostico_distinto_siempre_publica(tmp_path: Path) -> None:
    _correr(tmp_path, _Sesion(_wrf("MEDIO")), ahora=AHORA, hoy=HOY)
    cambio = _correr(
        tmp_path, _Sesion(_wrf("CRITICO")), ahora=AHORA + timedelta(hours=1), hoy=HOY
    )

    assert cambio["publication"] == "PUBLICADO"
    assert cambio["content_changed"] is True
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    assert {m["risk_category"] for m in publicado["maps"]} == {"MUY_ALTO"}


def test_la_ultima_corrida_valida_nunca_retrocede(tmp_path: Path) -> None:
    """Observado en producción el 07/08 (corrida 31147681704).

    `forecast_run_date` sale del `Last-Modified` del PRIMER mapa válido, y cuál
    es el primero depende de qué fechas sobrevivieron ese día. Entre dos
    corridas seguidas pasó de 06/08 a 05/08, y el tablero saltó de «hace 1 día»
    a «hace 2 días» sin que INIA hubiera perdido nada. Que hoy sólo sirvan
    mapas de una corrida más vieja no borra que ayer hubo una más nueva.
    """

    ayer = AHORA - timedelta(days=1)

    class _SesionConFecha:
        def __init__(self, cuerpo: bytes, last_modified: datetime) -> None:
            self.cuerpo = cuerpo
            self.lm = last_modified.strftime("%a, %d %b %Y %H:%M:%S GMT")

        def get(self, _url: str, **_kw: object) -> _Respuesta:
            return _Respuesta(200, self.cuerpo, {"Last-Modified": self.lm})

    # Primera corrida: INIA sirve mapas de HOY.
    _correr(tmp_path, _SesionConFecha(_wrf("MEDIO"), AHORA), ahora=AHORA, hoy=HOY)
    primero = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    assert primero["freshness"]["latest_valid_forecast"] == "2026-08-03"

    # Segunda corrida el MISMO día: ahora los mapas válidos son de la corrida
    # de ayer. El pronóstico cambia, pero la última corrida válida conocida no
    # puede envejecer.
    _correr(
        tmp_path,
        _SesionConFecha(_wrf("ALTO"), ayer),
        ahora=AHORA + timedelta(hours=2),
        hoy=HOY,
    )
    segundo = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )

    assert segundo["forecast_run_date"] == "2026-08-02", (
        "la corrida de ESTOS mapas sí es vieja"
    )
    assert segundo["freshness"]["latest_valid_forecast"] == "2026-08-03", (
        "pero la última corrida válida conocida no retrocede"
    )
    assert segundo["freshness"]["last_valid_age_days"] == 0
