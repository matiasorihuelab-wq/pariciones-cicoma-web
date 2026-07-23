# Control de Pariciones CICOMA 2026-2027

Tablero público estático con información productiva agregada de la campaña. La página lee
exclusivamente `data/dashboard.json`; no se conecta a la base operativa ni publica evidencias,
identificadores animales, mensajes, transcripciones o archivos multimedia.

Los indicadores usan datos confirmados. La información automática pendiente de revisión se mantiene
separada y no altera los totales productivos.

## Contenido publicado

- `index.html`: estructura accesible y responsive.
- `styles.css`: presentación para celular y escritorio.
- `app.js`: validación, gráficos y visualización del JSON.
- `data/dashboard.json`: proyección pública saneada y agregada.

Los valores no informados permanecen en `null`; nunca se completan silenciosamente con cero.
