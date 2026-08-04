"""Resumen legible de la corrida para la pantalla de GitHub Actions."""

from __future__ import annotations

import json
from pathlib import Path

CONTRATO = Path("data/chill_index.json")


def main() -> int:
    print("## Chill Index CICOMA\n")
    if not CONTRATO.exists():
        print("El pipeline no produjo contrato: revisar el paso anterior.")
        return 0

    datos = json.loads(CONTRATO.read_text(encoding="utf-8"))
    print(f"**Estado del sistema:** `{datos['status']}` — {datos['status_label']}\n")
    if datos.get("status_detail"):
        print(f"{datos['status_detail']}\n")

    frescura = datos.get("freshness", {})
    print(f"- Corrida de la fuente: `{datos.get('forecast_run_date') or 'sin corrida vigente'}`")
    print(f"- Mapas válidos: {frescura.get('maps_valid')} de {frescura.get('maps_total')}")
    print(f"- Cubre el día de hoy: {'sí' if frescura.get('covers_today') else 'no'}")
    ultimo = frescura.get("last_valid_forecast_run_date")
    if ultimo:
        dias = frescura.get("last_valid_age_days")
        print(f"- Último pronóstico válido conocido: {ultimo} (hace {dias} día/s)")
    print(f"- Verificado a las: {datos.get('run_finished_at')}\n")

    print("| Fecha | Resultado | Confianza | Motivo técnico |")
    print("|---|---|---|---|")
    for mapa in datos["maps"]:
        disponible = mapa["display_status"] == "DISPONIBLE"
        categoria = mapa["risk_category"] if disponible else "**Sin datos**"
        print(
            f"| {mapa['valid_date']} | {categoria} | {mapa['confidence']} "
            f"| {mapa['reason'] or '—'} |"
        )

    mini = datos.get("diagnostics", {}).get("wrf_mini", {})
    if mini.get("observations"):
        print(f"\n> WRF_mini observado como diagnóstico ({len(mini['observations'])} miniaturas). ")
        print("> No publica categorías productivas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
