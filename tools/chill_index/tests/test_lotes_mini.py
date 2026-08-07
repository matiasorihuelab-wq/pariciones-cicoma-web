"""Identidad temporal del lote de miniaturas y fallback WRF → WRF_mini.

Matriz acordada con el responsable el 2026-08-06. La regla que estas pruebas
fijan —y que ninguna optimización posterior puede erosionar— es:

    valid_date(Min_N) = batch_run_date + N

La fecha base pertenece al LOTE, no al día en que se lo descarga. Los reportes
históricos del proyecto (28/07 y 29/07) son la evidencia; la auditoría del
06/08 agregó que INIA **oscila** entre lotes bajo URLs estables, de modo que un
juego viejo puede reaparecer sin ser la corrida de hoy.

Los ítems R y S de la matriz (seis oportunidades diarias de cron y conservación
de ``workflow_dispatch``) viven en ``test_workflow_schedule.py``, que los cubre
con diez pruebas dedicadas; no se duplican acá.
"""

from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, date, datetime
from pathlib import Path

from PIL import Image

from tools.chill_index import batches, settings
from tools.chill_index.classifier import classify_mini
from tools.chill_index.cli import run

CAL_MINI = settings.load_mini_calibration()
MINI_SIZE: tuple[int, int] = (
    int(CAL_MINI["expected_size"][0]),
    int(CAL_MINI["expected_size"][1]),
)
AHORA = datetime(2026, 8, 3, 16, 0, tzinfo=UTC)
HOY = date(2026, 8, 3)


# ----------------------------------------------------------- utilidades ---


def _mini(categoria: str, marca: int = 0) -> bytes:
    """Miniatura pintada con el color de una categoría de la leyenda.

    ``marca`` altera un píxel de la esquina —fuera del marco cartográfico— para
    que dos slots del mismo color tengan hashes distintos, como ocurre en la
    fuente real. No afecta la clasificación.
    """

    image = Image.new("RGB", MINI_SIZE, (255, 255, 255))
    pixels = image.load()
    assert pixels is not None
    marco = CAL_MINI["frame"]
    for x in range(int(marco["x0"]) + 1, int(marco["x1"])):
        for y in range(int(marco["y0"]) + 1, int(marco["y1"])):
            pixels[x, y] = settings.PALETTE[categoria]
    pixels[0, 0] = (marca, 0, 0)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _mini_vacia() -> bytes:
    """Miniatura sin colores de paleta: el placeholder que INIA sirve a veces."""

    buffer = io.BytesIO()
    Image.new("RGB", MINI_SIZE, (255, 255, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


def _sha(cuerpo: bytes) -> str:
    return hashlib.sha256(cuerpo).hexdigest()


def _miembros(
    cuerpos: dict[int, bytes], momento: datetime
) -> dict[str, dict[str, object]]:
    """Miembros de un lote tal como los arma ``_observe_mini_batch``."""

    return {
        str(indice): {
            "sha256": _sha(cuerpo),
            "url": f"https://ejemplo/Min_{indice}.png",
            "last_modified": momento.strftime("%a, %d %b %Y %H:%M:%S GMT"),
            "last_modified_utc": momento.isoformat(),
            "bytes": len(cuerpo),
        }
        for indice, cuerpo in cuerpos.items()
    }


def _lote(run_date: str | None, cuerpos: dict[int, bytes]) -> batches.MiniBatch:
    miembros = _miembros(cuerpos, AHORA)
    hashes = {int(k): str(v["sha256"]) for k, v in miembros.items()}
    return batches.MiniBatch(
        batch_id=batches.batch_id(hashes),
        batch_run_date=run_date,
        first_seen_at=AHORA.isoformat(),
        last_seen_at=AHORA.isoformat(),
        members=miembros,
        run_date_source="prueba",
    )


def _juego(categoria: str = "ALTO") -> dict[int, bytes]:
    return {i: _mini(categoria, marca=i) for i in range(settings.HORIZON_DAYS)}


# ------------------------------------ A·B·C · la fecha la pone el lote ---


def test_a_el_lote_del_28_de_julio_fecha_sus_cinco_slots_desde_el_28() -> None:
    """Reporte histórico del 28/07: Min_0..Min_4 = 28/07 … 01/08."""

    lote = _lote("2026-07-28", _juego())
    esperado = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]
    obtenido = [lote.valid_date_of(i).isoformat() for i in range(5)]  # type: ignore[union-attr]
    assert obtenido == esperado


def test_b_el_lote_del_29_de_julio_corre_todo_un_dia() -> None:
    """Reporte histórico del 29/07: el MISMO índice significa otra fecha.

    Es la prueba que descarta ``hoy + N``: dos lotes con idéntica estructura de
    slots fechan distinto porque su corrida es distinta.
    """

    lote = _lote("2026-07-29", _juego())
    esperado = ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]
    obtenido = [lote.valid_date_of(i).isoformat() for i in range(5)]  # type: ignore[union-attr]
    assert obtenido == esperado
    anterior = _lote("2026-07-28", _juego())
    assert lote.valid_date_of(0) != anterior.valid_date_of(0)


def test_c_el_lote_vigente_del_4_de_agosto_alcanza_el_7_y_el_8(tmp_path: Path) -> None:
    """El lote sembrado por auditoría cubre las dos fechas que se querían rescatar."""

    lotes = batches.read_batches(tmp_path / "no_existe.jsonl")
    lote = lotes["3904c26b5f6d9fb1"]
    assert lote.batch_run_date == "2026-08-04"
    assert lote.index_for(date(2026, 8, 7)) == 3
    assert lote.index_for(date(2026, 8, 8)) == 4
    assert lote.index_for(date(2026, 8, 9)) is None, (
        "el horizonte del lote termina en el 08/08"
    )
    assert lote.index_for(date(2026, 8, 3)) is None, "un lote no pronostica hacia atrás"


# ------------------------------- D·E · el tiempo no recorre las fechas ---


def test_d_un_lote_que_reaparece_no_se_convierte_en_la_corrida_de_hoy(
    tmp_path: Path,
) -> None:
    """La oscilación observada el 04→05→06/08: volver a servirse no es re-correrse."""

    ruta = tmp_path / "mini_batches.jsonl"
    cuerpos = _juego()
    miembros = _miembros(cuerpos, AHORA)
    primero, _ = batches.observe(ruta, miembros, now=AHORA)
    assert primero.batch_run_date == "2026-08-03"

    dos_dias_despues = datetime(2026, 8, 5, 16, 0, tzinfo=UTC)
    miembros_tarde = _miembros(cuerpos, dos_dias_despues)
    otra_vez, _ = batches.observe(ruta, miembros_tarde, now=dos_dias_despues)

    assert otra_vez.batch_id == primero.batch_id
    assert otra_vez.batch_run_date == "2026-08-03", (
        "la fecha base es del lote, no del día en que se lo ve"
    )
    assert otra_vez.first_seen_at == primero.first_seen_at
    assert otra_vez.last_seen_at != primero.last_seen_at, (
        "sí se actualiza cuándo se lo vio por última vez"
    )


def test_e_cruzar_la_medianoche_no_recorre_las_fechas_del_lote(tmp_path: Path) -> None:
    """La prueba central: a las 23:59 y a las 00:01 el lote fecha igual."""

    ruta = tmp_path / "mini_batches.jsonl"
    cuerpos = _juego()
    antes = datetime(2026, 8, 3, 23, 59, tzinfo=UTC)
    despues = datetime(2026, 8, 4, 3, 1, tzinfo=UTC)  # ya es 04/08 en Uruguay

    lote_antes, _ = batches.observe(ruta, _miembros(cuerpos, antes), now=antes)
    lote_despues, _ = batches.observe(ruta, _miembros(cuerpos, antes), now=despues)

    assert lote_despues.batch_id == lote_antes.batch_id
    assert lote_despues.batch_run_date == lote_antes.batch_run_date
    assert lote_despues.valid_date_of(4) == lote_antes.valid_date_of(4)


# --------------------------- F·G · política conservadora del fechado ---


def test_f_un_lote_nuevo_recibe_fecha_cuando_la_evidencia_concuerda(
    tmp_path: Path,
) -> None:
    ruta = tmp_path / "mini_batches.jsonl"
    momento = datetime(2026, 8, 2, 11, 30, tzinfo=UTC)
    lote, _ = batches.observe(ruta, _miembros(_juego(), momento), now=AHORA)
    assert lote.batch_run_date == "2026-08-02"
    assert "Last-Modified" in lote.run_date_source


def test_g_sin_evidencia_coherente_el_lote_queda_indeterminado(tmp_path: Path) -> None:
    """Ante la duda no se adivina: un lote sin fecha no pronostica ninguna fecha."""

    ruta = tmp_path / "mini_batches.jsonl"
    cuerpos = _juego()
    miembros = _miembros(cuerpos, AHORA)
    # Un miembro dice otro día: la evidencia se contradice.
    miembros["2"]["last_modified_utc"] = datetime(
        2026, 7, 30, 12, 0, tzinfo=UTC
    ).isoformat()

    lote, lotes = batches.observe(ruta, miembros, now=AHORA)
    assert lote.batch_run_date is None
    assert lote.run_date_source.startswith(batches.UNDETERMINED)
    assert lote.valid_date_of(0) is None
    assert lote.index_for(date(2026, 8, 3)) is None
    for dia in range(1, 32):
        assert not [
            par
            for par in batches.forecast_for(date(2026, 8, dia), lotes)
            if par[0].batch_id == lote.batch_id
        ], "un lote indeterminado no puede resolver ninguna fecha"


def test_g2_sin_ningun_last_modified_tampoco_se_inventa_una_fecha(
    tmp_path: Path,
) -> None:
    ruta = tmp_path / "mini_batches.jsonl"
    miembros = _miembros(_juego(), AHORA)
    for datos in miembros.values():
        datos["last_modified_utc"] = None
    lote, _ = batches.observe(ruta, miembros, now=AHORA)
    assert lote.batch_run_date is None
    assert lote.run_date_source.startswith(batches.UNDETERMINED)
    assert lote.first_seen_at, "se registra cuándo se lo vio…"
    assert "first_seen" not in lote.run_date_source, "…pero verlo no lo fecha"


# ----------------------------------- H·I·J · identidad y oscilación ---


def test_h_un_last_modified_nuevo_no_cambia_la_identidad_de_un_lote_conocido(
    tmp_path: Path,
) -> None:
    """La identidad es el contenido. Que INIA reponga cabeceras no crea un lote."""

    ruta = tmp_path / "mini_batches.jsonl"
    cuerpos = _juego()
    original, _ = batches.observe(ruta, _miembros(cuerpos, AHORA), now=AHORA)
    mas_tarde = datetime(2026, 8, 6, 9, 0, tzinfo=UTC)
    igual, lotes = batches.observe(ruta, _miembros(cuerpos, mas_tarde), now=mas_tarde)

    assert igual.batch_id == original.batch_id
    assert igual.batch_run_date == original.batch_run_date
    assert len(lotes) == 1 + len(batches.SEEDED_BATCHES)


def test_i_la_oscilacion_del_servidor_conserva_las_dos_identidades(
    tmp_path: Path,
) -> None:
    """04/08 lote A · 05/08 lote B · 06/08 lote A otra vez: nada se pisa."""

    ruta = tmp_path / "mini_batches.jsonl"
    juego_a = _juego("ALTO")
    juego_b = _juego("BAJO")

    dia4 = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)
    dia5 = datetime(2026, 8, 5, 12, 0, tzinfo=UTC)
    dia6 = datetime(2026, 8, 6, 12, 0, tzinfo=UTC)

    a1, _ = batches.observe(ruta, _miembros(juego_a, dia4), now=dia4)
    b1, _ = batches.observe(ruta, _miembros(juego_b, dia5), now=dia5)
    a2, lotes = batches.observe(ruta, _miembros(juego_a, dia4), now=dia6)

    assert a1.batch_id != b1.batch_id
    assert a2.batch_id == a1.batch_id
    assert a2.batch_run_date == "2026-08-04", "el lote que vuelve conserva su corrida"
    assert lotes[b1.batch_id].batch_run_date == "2026-08-05", (
        "el otro lote no se pierde"
    )
    persistidos = [
        json.loads(linea)
        for linea in ruta.read_text(encoding="utf-8").splitlines()
        if linea.strip()
    ]
    assert len({p["batch_id"] for p in persistidos}) >= 2


def test_j_varios_lotes_para_la_misma_fecha_se_ordenan_del_mas_nuevo_al_mas_viejo() -> (
    None
):
    viejo = _lote("2026-08-01", _juego("BAJO"))
    nuevo = _lote("2026-08-03", _juego("ALTO"))
    lotes = {viejo.batch_id: viejo, nuevo.batch_id: nuevo}

    orden = batches.forecast_for(date(2026, 8, 5), lotes)
    assert [par[0].batch_id for par in orden] == [nuevo.batch_id, viejo.batch_id]
    assert [par[1] for par in orden] == [2, 4], (
        "cada lote aporta el slot que le corresponde"
    )


# ------------------------------------- K·L·M·N · fallback de extremo a extremo ---


class _Respuesta:
    def __init__(
        self, status: int, content: bytes = b"", headers: dict | None = None
    ) -> None:
        self.status_code = status
        self.content = content
        self.headers = headers or {}


class _SesionPorUrl:
    """Cliente HTTP simulado que responde por coincidencia de subcadena."""

    def __init__(self, rutas: dict[str, _Respuesta], por_defecto: _Respuesta) -> None:
        self.rutas = rutas
        self.por_defecto = por_defecto
        self.pedidos: list[str] = []

    def get(self, url: str, **_: object) -> _Respuesta:
        self.pedidos.append(url)
        for clave, valor in self.rutas.items():
            if clave in url:
                return valor
        return self.por_defecto


def _lm(momento: datetime) -> str:
    return momento.strftime("%a, %d %b %Y %H:%M:%S GMT")


def _wrf_vacio() -> bytes:
    """WRF completo con marco pero sin grilla: 'Entire Grid Undefined'."""

    cal = settings.load_calibration()
    image = Image.new("RGB", settings.WRF_EXPECTED_SIZE, (255, 255, 255))
    pixels = image.load()
    assert pixels is not None
    marco = cal["frame"]
    for x in range(int(marco["x0"]), int(marco["x1"])):
        pixels[x, int(marco["y0"])] = (0, 0, 0)
        pixels[x, int(marco["y1"])] = (0, 0, 0)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _wrf_pintado(categoria: str) -> bytes:
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


def _correr(tmp_path: Path, sesion: object, **extra: object) -> dict:
    return run(
        output=tmp_path / "data" / "chill_index.json",
        evidence_root=tmp_path / "evidence",
        history_path=tmp_path / "data" / "chill_history.jsonl",
        batches_path=tmp_path / "data" / "mini_batches.jsonl",
        trigger="test",
        today=HOY,
        now=AHORA,
        session=sesion,
        **extra,  # type: ignore[arg-type]
    )


def test_k_si_el_lote_mas_nuevo_no_sirve_se_cae_al_anterior(tmp_path: Path) -> None:
    """Placeholder en el lote nuevo, mapa útil en el viejo: gana el que sirve.

    El pronóstico más reciente manda, pero «más reciente» no significa
    «publicable»: si su slot es un placeholder se recorre al lote anterior en
    vez de dejar la fecha sin dato.
    """

    # El lote de hoy trae un placeholder en el slot 2 (que fecha el 05/08).
    hoy_cuerpos = {
        i: (_mini_vacia() if i == 2 else _mini("BAJO", marca=i)) for i in range(5)
    }
    # Un lote del 01/08 —ya conocido— fecha el 05/08 en su slot 4.
    viejo_cuerpo = _mini("ALTO", marca=9)
    viejo = _lote("2026-08-01", {i: _mini("ALTO", marca=9 + i) for i in range(5)})
    viejo.members["4"]["sha256"] = _sha(viejo_cuerpo)
    ruta = tmp_path / "data" / "mini_batches.jsonl"
    batches.write_batches(ruta, {viejo.batch_id: viejo})

    rutas = {
        f"Min_{i}.png": _Respuesta(200, cuerpo, {"Last-Modified": _lm(AHORA)})
        for i, cuerpo in hoy_cuerpos.items()
    }
    rutas["Min_4.png"] = _Respuesta(200, viejo_cuerpo, {"Last-Modified": _lm(AHORA)})
    sesion = _SesionPorUrl(
        rutas, _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)})
    )

    resumen = _correr(tmp_path, sesion)
    traza = {t["valid_date"]: t for t in resumen["sources_by_date"]}
    quinto = traza["2026-08-05"]
    assert quinto["source_product"] == "WRF_MINI"
    assert quinto["batch_run_date"] == "2026-08-01", (
        "resolvió el lote viejo, no el de hoy"
    )
    assert quinto["mini_index"] == 4
    assert quinto["rejected_batches"], (
        "queda registrado que el lote nuevo se descartó primero"
    )
    assert quinto["category"] == "ALTO"


def test_l_con_el_wrf_completo_valido_el_mini_no_se_usa(tmp_path: Path) -> None:
    """Prioridad del producto primario: el fallback es excepción, no atajo."""

    sesion = _SesionPorUrl(
        {"Min_": _Respuesta(200, _mini("CRITICO"), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _wrf_pintado("BAJO"), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    productos = {t["source_product"] for t in resumen["sources_by_date"]}
    assert productos == {"WRF"}, f"el mini no debía intervenir: {productos}"
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    assert {m["risk_category"] for m in publicado["maps"]} == {"BAJO"}


def test_m_el_mini_rescata_la_fecha_y_deja_su_trazabilidad(tmp_path: Path) -> None:
    sesion = _SesionPorUrl(
        {
            f"Min_{i}.png": _Respuesta(
                200, _mini("ALTO", marca=i), {"Last-Modified": _lm(AHORA)}
            )
            for i in range(5)
        },
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    minis = [t for t in resumen["sources_by_date"] if t["source_product"] == "WRF_MINI"]
    assert minis, "el mini debía resolver las fechas que el WRF dejó vacías"
    for traza in minis:
        assert traza["batch_id"], "toda categoría de fallback dice de qué lote salió"
        assert traza["batch_run_date"] == "2026-08-03"
        # La fecha resuelta es la que le corresponde al slot dentro del lote.
        esperada = date.fromisoformat(traza["batch_run_date"])
        assert (date.fromisoformat(traza["valid_date"]) - esperada).days == traza[
            "mini_index"
        ]
        assert traza["fallback_reason"], "queda dicho por qué no se usó el WRF completo"


def test_n_si_ninguno_de_los_dos_sirve_no_se_inventa_una_categoria(
    tmp_path: Path,
) -> None:
    sesion = _SesionPorUrl(
        {"Min_": _Respuesta(200, _mini_vacia(), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    for mapa in publicado["maps"]:
        assert mapa["risk_category"] != "SIN_RIESGO", (
            "sin dato NO es ausencia de riesgo"
        )
        assert mapa["availability_status"] in ("SIN_DATOS", "ERROR")
    assert publicado["status"] == "SIN_PRONOSTICO_CONFIABLE"


def test_un_lote_del_que_no_conocemos_los_cuerpos_no_puede_fechar_nada(
    tmp_path: Path,
) -> None:
    """Regresión encontrada al escribir esta matriz (2026-08-06).

    Las URLs ``Min_N`` sirven siempre el juego VIGENTE. Un lote conocido sólo de
    nombre —una semilla de auditoría, o cualquier lote cuyos hashes no estén
    persistidos— no puede comprobar que lo servido sea suyo. Si se le permitiera
    resolver, le pondría SU fecha a los píxeles de otro juego: exactamente el
    error de fechado que esta fase vino a eliminar.
    """

    fantasma = batches.MiniBatch(
        batch_id="lote_sin_cuerpos",
        batch_run_date="2026-08-04",  # el más reciente: sería el primer candidato
        first_seen_at="",
        last_seen_at="",
        members={},
        run_date_source="sembrado por auditoría, todavía no observado",
    )
    batches.write_batches(
        tmp_path / "data" / "mini_batches.jsonl", {fantasma.batch_id: fantasma}
    )

    sesion = _SesionPorUrl(
        {
            f"Min_{i}.png": _Respuesta(
                200, _mini("MEDIO", marca=i), {"Last-Modified": _lm(AHORA)}
            )
            for i in range(5)
        },
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)

    for traza in resumen["sources_by_date"]:
        assert traza.get("batch_id") != fantasma.batch_id, (
            "un lote sin cuerpos conocidos no puede resolver una fecha"
        )
    rechazos = [
        r
        for t in resumen["sources_by_date"]
        for r in t.get("rejected_batches", [])
        if r["batch_id"] == fantasma.batch_id
    ]
    assert rechazos, "y su descarte tiene que quedar registrado"
    assert all("no se conocen los cuerpos" in r["resultado"] for r in rechazos)


# ------------------------------------------- O·P·Q · categorías y umbrales ---


def test_o_el_violeta_de_la_leyenda_se_clasifica_como_critico() -> None:
    """RGB (160,0,200) es la categoría más severa, verificada contra INIA."""

    imagen = Image.open(io.BytesIO(_mini("CRITICO"))).convert("RGB")
    resultado = classify_mini(
        imagen,
        CAL_MINI,
        lat=float(settings.LOCATION["latitude"]),
        lon=float(settings.LOCATION["longitude"]),
    )
    # `classify_mini` devuelve el nombre PÚBLICO, igual que `classify`: la
    # categoría interna CRITICO viaja al contrato como MUY_ALTO. El rótulo que
    # ve el usuario —«Crítico»— lo pone el frontend.
    assert resultado.category == "MUY_ALTO"
    assert settings.RISK_PUBLIC_NAME["CRITICO"] == "MUY_ALTO"
    assert settings.PALETTE["CRITICO"] == (160, 0, 200)


def test_p_por_encima_de_1200_la_categoria_es_critica() -> None:
    bajo, alto = settings.RISK_INTERVALS["CRITICO"]
    assert bajo == 1200.0
    assert alto is None, "la categoría más severa no tiene techo"
    assert settings.RISK_PUBLIC_NAME["CRITICO"] == "MUY_ALTO", (
        "MUY_ALTO es el identificador del contrato; el rótulo visible es «Crítico»"
    )


def test_q_entre_1100_y_1200_la_categoria_es_alto() -> None:
    assert settings.RISK_INTERVALS["ALTO"] == (1100.0, 1200.0)
    orden = list(settings.RISK_SCALE)
    assert orden.index("ALTO") == orden.index("CRITICO") - 1, (
        "ALTO es el escalón previo"
    )


# ----------------------------- T·U · cambio de contenido e idempotencia ---


def test_t_la_misma_url_con_otro_contenido_se_detecta_y_no_se_confunde(
    tmp_path: Path,
) -> None:
    """El caso documentado del 06/08: la URL no cambia, el cuerpo sí.

    Dos cosas tienen que pasar: nace un lote distinto (la identidad es el
    contenido) y el slot deja de servir para el lote anterior, que ya no puede
    reclamarlo como suyo.
    """

    ruta = tmp_path / "mini_batches.jsonl"
    primero, _ = batches.observe(ruta, _miembros(_juego("ALTO"), AHORA), now=AHORA)
    segundo, lotes = batches.observe(ruta, _miembros(_juego("BAJO"), AHORA), now=AHORA)

    assert primero.batch_id != segundo.batch_id, "otro contenido es otro lote"
    assert len(lotes) >= 2, (
        "el lote anterior no se borra: queda para reconocerlo si vuelve"
    )

    # El pipeline verifica el cuerpo servido contra el miembro del lote.
    sesion = _SesionPorUrl(
        {
            "Min_": _Respuesta(
                200, _mini("BAJO", marca=99), {"Last-Modified": _lm(AHORA)}
            )
        },
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    # Se lo fecha por delante del juego que INIA sirve hoy para que sea el
    # PRIMER candidato: así se comprueba que lo descarta el contenido y no el orden.
    viejo = _lote("2026-08-04", _juego("ALTO"))
    batches.write_batches(
        tmp_path / "data" / "mini_batches.jsonl", {viejo.batch_id: viejo}
    )
    resumen = _correr(tmp_path, sesion)
    rechazos = [
        r
        for t in resumen["sources_by_date"]
        for r in t.get("rejected_batches", [])
        if r["batch_id"] == viejo.batch_id
    ]
    assert rechazos, "el lote viejo tenía que quedar descartado por contenido"
    assert all("cuerpo" in r["resultado"] for r in rechazos)


def test_u_el_mismo_contenido_no_genera_una_publicacion_nueva(tmp_path: Path) -> None:
    sesion = _SesionPorUrl(
        {"Min_": _Respuesta(200, _mini("ALTO"), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _wrf_pintado("MEDIO"), {"Last-Modified": _lm(AHORA)}),
    )
    primera = _correr(tmp_path, sesion)
    segunda = _correr(tmp_path, sesion)

    assert primera["publication"] == "PUBLICADO"
    assert segunda["publication"] == "SIN_CAMBIOS"
    assert segunda["output_hash"] == primera["output_hash"]

    lotes = batches.read_batches(tmp_path / "data" / "mini_batches.jsonl")
    observados = [x for x in lotes.values() if x.batch_id not in batches.SEEDED_BATCHES]
    assert len(observados) == 1, "el mismo juego no puede aparecer como dos lotes"


def test_el_recuento_de_mapas_validos_no_contradice_la_lista_publicada(
    tmp_path: Path,
) -> None:
    """Regresión de la corrida real del 07/08.

    ``maps_valid`` contaba sólo los aciertos del WRF completo, así que el
    contrato decía «1 de 5» mientras publicaba dos fechas con categoría. Una
    fecha rescatada por el mini es una fecha publicada: tiene que contarse.
    """

    # Sólo el slot 0 del juego sirve; el WRF completo no sirve para ninguna.
    cuerpos = {
        i: (_mini("ALTO", marca=i) if i == 0 else _mini_vacia()) for i in range(5)
    }
    sesion = _SesionPorUrl(
        {
            f"Min_{i}.png": _Respuesta(200, c, {"Last-Modified": _lm(AHORA)})
            for i, c in cuerpos.items()
        },
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    resumen = _correr(tmp_path, sesion)
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )

    disponibles = [
        m for m in publicado["maps"] if m["availability_status"] == "DISPONIBLE"
    ]
    assert len(disponibles) == 1, "sólo el slot 0 podía resolverse"
    assert publicado["freshness"]["maps_valid"] == len(disponibles)
    assert resumen["maps_rescued_by_mini"] == 1
    # Pero un rescate del mini NO inventa una corrida nueva del WRF.
    assert publicado["forecast_run_date"] is None


# ------------------------------------ vigencia: verificar ≠ pronosticar ---


def test_la_verificacion_de_hoy_no_se_publica_como_pronostico_de_hoy(
    tmp_path: Path,
) -> None:
    """El defecto que originó esta fase: mirar la fuente no es tener dato nuevo."""

    sesion = _SesionPorUrl(
        {"Min_": _Respuesta(200, _mini_vacia(), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _wrf_vacio(), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    vigencia = publicado["freshness"]

    assert vigencia["latest_source_seen"] is not None, "sí se verificó la fuente hoy"
    assert vigencia["latest_valid_forecast"] is None, "y no hay ninguna corrida válida"
    assert publicado["forecast_run_date"] is None
    assert vigencia["latest_source_seen"] != vigencia["latest_valid_forecast"]


def test_los_dos_conceptos_de_vigencia_viajan_separados(tmp_path: Path) -> None:
    sesion = _SesionPorUrl(
        {"Min_": _Respuesta(200, _mini("ALTO"), {"Last-Modified": _lm(AHORA)})},
        _Respuesta(200, _wrf_pintado("MEDIO"), {"Last-Modified": _lm(AHORA)}),
    )
    _correr(tmp_path, sesion)
    publicado = json.loads(
        (tmp_path / "data" / "chill_index.json").read_text(encoding="utf-8")
    )
    vigencia = publicado["freshness"]
    assert vigencia["latest_valid_forecast"] == HOY.isoformat()
    assert vigencia["latest_source_seen"], "la verificación se sigue informando aparte"
