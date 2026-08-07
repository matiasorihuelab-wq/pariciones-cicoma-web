"""El cron del workflow: seis controles, decididos con evidencia.

La cadencia no es una preferencia estética. La auditoría sombra observó el
`Last-Modified` de los mapas a las 06:00–07:00 hora de Uruguay en la mayoría de
los días, y republicaciones bajo la misma URL con sello de las 14:00. El
esquema anterior (13:00 / 14:30 / 16:00 / 18:00 local) no miraba nunca la
franja temprana y concentraba las cuatro oportunidades en cinco horas: el
2026-08-06 los runners de GitHub fallaron dos veces seguidas y el pronóstico
quedó congelado más de 24 h.
"""

from __future__ import annotations

import re
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[3] / ".github" / "workflows" / "chill-index.yml"
)

#: Horarios esperados, en UTC. GitHub Actions interpreta el cron en UTC y
#: Uruguay es UTC-3 todo el año.
CONTROLES_UTC = ((10, 17), (14, 17), (16, 17), (17, 47), (19, 17), (21, 47))


def _crons() -> list[tuple[int, int]]:
    texto = WORKFLOW.read_text(encoding="utf-8")
    horarios = []
    for expresion in re.findall(r'-\s*cron:\s*"([^"]+)"', texto):
        minuto, hora = expresion.split()[:2]
        assert "," not in hora, "una hora por línea: es más fácil de leer y de auditar"
        horarios.append((int(hora), int(minuto)))
    return sorted(horarios)


def test_hay_seis_controles_diarios() -> None:
    assert len(_crons()) == 6


def test_los_horarios_son_los_decididos_por_la_auditoria() -> None:
    assert _crons() == sorted(CONTROLES_UTC)


def test_dos_controles_caen_antes_de_la_ventana_de_la_tarde() -> None:
    """La auditoría vio sellos a las 06:00–07:00 local (09:00–10:00 UTC)."""

    tempranos = [(h, m) for h, m in _crons() if h < 16]
    assert len(tempranos) == 2, (
        "sin controles tempranos se pierde la publicación matinal"
    )
    assert min(h for h, _ in tempranos) <= 10, (
        "el primero debe cubrir el sello de las 07:00 local"
    )


def test_cuatro_controles_cubren_la_ventana_de_republicacion() -> None:
    """Republicaciones observadas bajo la misma URL con sello de 14:00 local."""

    ventana = [(h, m) for h, m in _crons() if h >= 16]
    assert len(ventana) == 4
    # Próximos entre sí: ninguna separación mayor a 2 h 30 dentro de la ventana.
    minutos = sorted(h * 60 + m for h, m in ventana)
    huecos = [b - a for a, b in zip(minutos, minutos[1:], strict=False)]
    assert max(huecos) <= 150, f"hueco demasiado grande en la ventana: {huecos}"


def test_no_se_desperdician_intentos_en_la_madrugada() -> None:
    """«Cada 6 horas» gastaría tres de cuatro intentos sin sellos observados."""

    locales = [(h - 3) % 24 for h, _ in _crons()]
    assert not [h for h in locales if 0 <= h < 6], (
        "ningún sello observado cae en la madrugada"
    )


def test_ningun_control_arranca_en_punto() -> None:
    """El comienzo exacto de hora es cuando más carga tiene la cola de Actions."""

    assert all(m != 0 for _, m in _crons())


def test_un_fallo_de_runner_no_deja_el_dia_sin_control() -> None:
    """El 2026-08-06 fallaron dos corridas seguidas por el runner de GitHub.

    Con seis controles, dos fallos consecutivos siguen dejando cuatro
    oportunidades el mismo día.
    """

    assert len(_crons()) - 2 >= 4


def test_se_conserva_la_ejecucion_manual() -> None:
    texto = WORKFLOW.read_text(encoding="utf-8")
    assert "workflow_dispatch:" in texto


def test_el_workflow_declara_que_el_cron_es_best_effort() -> None:
    """No se puede prometer puntualidad al minuto: GitHub es best effort."""

    texto = WORKFLOW.read_text(encoding="utf-8").casefold()
    assert "best effort" in texto
    assert (
        "no son una garantía al minuto" in texto
        or "no son una garantia al minuto" in texto
    )


def test_el_workflow_documenta_por_que_no_es_cada_seis_horas() -> None:
    texto = WORKFLOW.read_text(encoding="utf-8")
    assert "cada 6 horas" in texto.casefold()
    assert "06:00" in texto and "07:00" in texto, "debe citar los sellos observados"


def test_el_workflow_persiste_la_identidad_de_los_lotes() -> None:
    """Sin este archivo versionado la arquitectura de lotes no existe en producción.

    `data/mini_batches.jsonl` es la memoria entre corridas: qué juegos de
    miniaturas ya se conocen y a qué corrida pertenece cada uno. Si el workflow
    no lo pasara al pipeline y no lo commiteara, cada ejecución arrancaría en
    blanco y volvería a fechar por `Last-Modified` un juego viejo que INIA
    re-sirve — el error que esta fase cerró.
    """

    texto = WORKFLOW.read_text(encoding="utf-8")
    assert "--batches data/mini_batches.jsonl" in texto, (
        "el pipeline tiene que recibir la ruta del archivo de lotes"
    )
    add = [
        linea
        for linea in texto.splitlines()
        if "git add" in linea or "mini_batches" in linea
    ]
    assert any("mini_batches.jsonl" in linea for linea in add), (
        "el archivo de lotes tiene que quedar versionado en el commit de la corrida"
    )
