# CICOMA - Monitoreo de pariciones 2026

Tablero público estático con información productiva agregada de la campaña. La página lee
exclusivamente `data/dashboard.json`; no se conecta a la base operativa ni publica evidencias,
identificadores animales, mensajes, transcripciones o archivos multimedia.

Los datos se actualizan automáticamente desde los registros operativos y se contabilizan en los
indicadores. Pueden ajustarse si se recibe una corrección posterior, que queda trazada.

## Contenido publicado

- `index.html`: estructura accesible y responsive (referencia `app.js` y
  `styles.css` versionados por hash de contenido).
- `styles.css`: presentación para celular y escritorio.
- `app.js`: validación estricta del contrato, gráficos y visualización del JSON.
- `assets/logo-sul-60.png`: logotipo institucional del SUL.
- `data/dashboard.json`: proyección pública saneada y agregada (esquema 3.2.0).
- `data/chill_pariciones.json`: proyección pública del Chill Index.

Los valores no informados permanecen en `null`; nunca se completan
silenciosamente con cero. Los totales con lotes sin recuento se publican
identificados como parciales. Tras un despliegue, una recarga de la página
obtiene la versión nueva; una pestaña ya abierta sigue con la versión anterior
hasta recargar.
