# CICOMA - Monitoreo de pariciones 2026

Tablero público estático con información productiva agregada de la campaña. La página lee
exclusivamente `data/dashboard.json`; no se conecta a la base operativa ni publica evidencias,
identificadores animales, mensajes, transcripciones o archivos multimedia.

Los datos se actualizan automáticamente desde los registros operativos y se contabilizan en los
indicadores. Pueden ajustarse si se recibe una corrección posterior, que queda trazada.

## Contenido publicado

- `index.html`: estructura accesible y responsive.
- `styles.css`: presentación para celular y escritorio.
- `app.js`: validación, gráficos y visualización del JSON.
- `assets/logo-sul-60.png`: logotipo institucional del SUL.
- `data/dashboard.json`: proyección pública saneada y agregada.

Los valores no informados permanecen en `null`; nunca se completan silenciosamente con cero.
