"use strict";

/* Tablero público CICOMA — monitoreo de pariciones 2026.
 * Fuente canónica versionada: APP/web_source (WEB es staging generado).
 * Lee exclusivamente data/dashboard.json (esquema 3.5.0), validando el
 * contrato antes de renderizar. Navegación por menú lateral con secciones por
 * lote. Nunca convierte un faltante en cero, nunca presenta un acumulado como
 * valor diario y nunca calcula un total parcial como si fuera completo. */

const DATA_URL = "./data/dashboard.json";
//: Contrato del pipeline autónomo del Chill Index. Lo publica GitHub Actions
//: directamente en este repositorio: no pasa por Zapia ni por Google Drive.
const CHILL_INDEX_URL = "./data/chill_index.json";
let CHILL_INDEX = null;
const SUPPORTED_SCHEMA = "3.5.0";
const SECTIONS = ["resumen", "intensivo", "dohne", "ma"];
const LOTS = [
  { code: "INTENSIVO", section: "intensivo", name: "Intensivo", breed: "Merino Australiano X Hampshire Down" },
  { code: "DOHNE", section: "dohne", name: "Merino Dohne", breed: null },
  { code: "MA", section: "ma", name: "Merino Australiano", breed: null },
];
const CODE_BY_SECTION = Object.fromEntries(LOTS.map((lot) => [lot.section, lot.code]));
const RISK_ORDER = ["SIN_RIESGO", "BAJO", "MEDIO", "ALTO", "CRITICO"];
const INCOMPLETE_RISK = "RIESGO_72H_INCOMPLETO";
// Texto público obligatorio del estado incompleto. No se usa la forma abreviada.
const INCOMPLETE_RISK_LABEL = "EVALUACIÓN DE 72 HORAS INCOMPLETA";
// Icono discreto de evidencia multimedia. El contenido (foto/video) nunca se
// publica: sólo señala que existe y se consulta en la gestión interna.
const MEDIA_ICON =
  '<svg class="mort-media__icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L18 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.2"/></svg>';

let DASH = null;
let AGE_TIMER = null;
// Estado de los filtros del gráfico integral, por vista (una por sección).
const CHART_STATE = {};

const integerFormatter = new Intl.NumberFormat("es-UY", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("es-UY", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Cocientes por animal (prolificidad): dos decimales. No se usa para porcentajes.
const ratioFormatter = new Intl.NumberFormat("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInteger(value) {
  return value === null || value === undefined ? "—" : integerFormatter.format(value);
}

function formatDecimal(value) {
  return value === null || value === undefined ? "—" : decimalFormatter.format(value);
}

function formatPercent(value) {
  return value === null || value === undefined ? "—" : `${decimalFormatter.format(value)} %`;
}

function formatExposure(value) {
  if (value === null || value === undefined) return "—";
  return integerFormatter.format(Math.round(Number(value)));
}

function formatDate(dateString, options = {}) {
  if (!dateString) return "—";
  const [year, month, day] = dateString.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "—";
  return new Intl.DateTimeFormat("es-UY", {
    day: "2-digit",
    month: options.short ? "short" : "2-digit",
    year: options.includeYear === false ? undefined : "numeric",
  }).format(new Date(year, month - 1, day));
}

// Día y mes con dos dígitos (26/07), estable en cualquier localización.
function formatDayMonth(dateString) {
  const [, month, day] = (dateString || "").slice(0, 10).split("-");
  if (!month || !day) return "—";
  return `${day}/${month}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// dd/mm/aaaa, con el mismo criterio que formatDayMonth: sin Intl, para que el
// formato no dependa de la localización del navegador. Un valor que no sea una
// fecha ISO completa no se dibuja: se devuelve la marca de dato ausente.
function formatDayMonthYear(dateString) {
  const iso = (dateString || "").slice(0, 10);
  if (!ISO_DATE_RE.test(iso)) return "—";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function formatDateTime(value, timezone) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: timezone || "America/Montevideo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function riskClass(category) {
  if (RISK_ORDER.includes(category)) return category.toLowerCase().replace("_", "-");
  if (category === INCOMPLETE_RISK) return "incompleto";
  return "unknown";
}

// Categorías públicas del riesgo climático, cerradas y en lenguaje claro.
const RISK_LABELS = {
  SIN_RIESGO: "SIN RIESGO",
  BAJO: "RIESGO BAJO",
  MEDIO: "RIESGO MEDIO",
  ALTO: "RIESGO ALTO",
  CRITICO: "RIESGO CRÍTICO",
  NO_DETERMINADO: "NO DETERMINADO",
  [INCOMPLETE_RISK]: INCOMPLETE_RISK_LABEL,
};

function riskLabel(category) {
  if (!category) return "NO INFORMADO";
  return RISK_LABELS[category] || String(category).replaceAll("_", " ");
}

/* ---------------------------------------------------------------- carga --- */

const TOTAL_STATUSES = new Set(["COMPLETE", "PARTIAL", "NOT_REPORTED"]);
const REMAINING_STATUSES = new Set(["OK", "SIN_RECUENTO", "PARCIAL", "NO_INFORMADO", "ERROR"]);
const ESTIMATED_STATUSES = new Set(["OK", "SEGUN_REGISTROS", "SIN_RECUENTO", "NO_INFORMADO", "ERROR"]);
const PROGRESS_STATUSES = new Set(["OK", "SEGUN_REGISTROS", "SIN_RECUENTO", "NO_INFORMADO"]);
const REGISTERED_STATUSES = new Set(["EXACTO", "MINIMO_CONFIRMADO", "SIN_RECUENTO"]);

// Contrato estricto del lado del cliente. Un contrato inválido corta la carga
// con un error visible (caja de error), sin aplicar valores por defecto
// engañosos: un estado ausente o desconocido NUNCA se convierte en OK.
function assertDashboard(data) {
  if (!data || typeof data !== "object") throw new Error("JSON inválido");
  if (data.schema_version !== SUPPORTED_SCHEMA) {
    throw new Error(`Versión de esquema no compatible: ${data.schema_version}`);
  }
  for (const field of ["overview", "system_health", "chill_public", "field_controls", "campaign_milestones"]) {
    if (!data[field] || typeof data[field] !== "object") throw new Error(`Falta ${field}`);
  }
  if (!Array.isArray(data.modules)) throw new Error("Falta la lista de módulos");
  if (!Array.isArray(data.mortality_daily)) throw new Error("Falta la mortalidad diaria");

  // Misma validación que aplica effectiveHealth: una sola fuente de verdad.
  // Si el estado es inválido, esto lanza y la carga se corta con error visible.
  effectiveHealth(data.system_health, data.generated_at, data.max_age_minutes, Date.now());

  for (const key of ["lambed_ewes", "born_lambs", "born_alive", "stillborn", "registered_born_lambs"]) {
    const total = data.overview[key];
    if (!total || typeof total !== "object" || !TOTAL_STATUSES.has(total.status)) {
      throw new Error(`Total observado inválido: overview.${key}`);
    }
  }
  for (const key of ["remaining_ewes", "remaining_lambs"]) {
    const block = data.overview[key];
    if (!block || typeof block !== "object" || !REMAINING_STATUSES.has(block.status)) {
      throw new Error(`Cantidad restante inválida: overview.${key}`);
    }
    if (typeof block.value === "number" && block.value < 0) {
      throw new Error(`Cantidad restante negativa: overview.${key}`);
    }
  }
  // Restantes estimados: exigen base explícita y jamás un valor negativo.
  for (const key of ["remaining_ewes_estimated", "remaining_lambs_estimated"]) {
    const block = data.overview[key];
    if (!block || typeof block !== "object" || !ESTIMATED_STATUSES.has(block.status)) {
      throw new Error(`Restante estimado inválido: overview.${key}`);
    }
    if (typeof block.value === "number" && block.value < 0) {
      throw new Error(`Cantidad restante negativa: overview.${key}`);
    }
    if (typeof block.basis !== "string" || block.basis.trim() === "") {
      throw new Error(`Restante estimado sin base de cálculo: overview.${key}`);
    }
  }
  for (const key of ["ewe_progress", "lamb_progress"]) {
    const block = data.overview[key];
    if (!block || typeof block !== "object" || !PROGRESS_STATUSES.has(block.status)) {
      throw new Error(`Avance inválido: overview.${key}`);
    }
  }
  const coverage = data.overview.coverage;
  if (!coverage || !Array.isArray(coverage.lots_with_records) || !Array.isArray(coverage.lots_without_records)) {
    throw new Error("Cobertura de registros inválida: overview.coverage");
  }
  for (const module of data.modules) {
    const lamb = module.lamb_counts || {};
    if (!REGISTERED_STATUSES.has(lamb.registered_born_status)) {
      throw new Error(`Estado de corderos registrados inválido en ${module.code}`);
    }
    if (lamb.stillborn_status !== "INFORMADO" && lamb.stillborn_status !== "NO_INFORMADO") {
      throw new Error(`Estado de nacidos muertos inválido en ${module.code}`);
    }
  }
}

async function boot() {
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    assertDashboard(data);
    DASH = data;
    // Contrato del pipeline autónomo (GitHub Actions → Pages). Se pide aparte:
    // si faltara, el resto del tablero igual se muestra.
    await loadChillIndex();
    renderAll();
    initRouter();
    initHealth();
    startAgeClock();
  } catch (error) {
    const box = byId("load-error");
    if (box) {
      box.hidden = false;
      box.querySelector("span").textContent = String(error.message || error);
    }
  }
}

function renderAll() {
  renderHealth();
  renderResumen();
  LOTS.forEach(renderLot);
}

/* --------------------------------------------------------------- salud --- */

function computeAgeMinutes(generatedAtIso, nowMs) {
  if (!generatedAtIso) return null;
  const stamp = new Date(generatedAtIso);
  if (Number.isNaN(stamp.getTime())) return null;
  return Math.max(0, (nowMs - stamp.getTime()) / 60000);
}

function ageMinutes() {
  const generated = DASH.generated_at || DASH.system_health?.generated_at;
  return computeAgeMinutes(generated, Date.now());
}

function ageText(minutes) {
  if (minutes === null) return "—";
  if (minutes < 60) return `hace ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

// Motivo válido: objeto con código y mensaje no vacíos.
function isValidReason(reason) {
  return (
    !!reason &&
    typeof reason === "object" &&
    typeof reason.code === "string" &&
    reason.code.trim() !== "" &&
    typeof reason.message === "string" &&
    reason.message.trim() !== ""
  );
}

// El backend (build_system_status) es la ÚNICA autoridad para decidir OK/OJO.
// La antigüedad de la publicación se muestra sólo como dato informativo y NUNCA
// convierte un OK del backend en OJO: Zapia no tiene una cadencia fija y pueden
// pasar horas entre reportes sin que exista ninguna incidencia real. Cuando el
// backend informa OJO, se muestran sus motivos tal cual llegan (sin inventar).
//
// La función es segura POR SÍ MISMA: no depende de que assertDashboard se haya
// ejecutado antes. Un estado ausente, "ERROR", null o desconocido lanza; jamás
// se coacciona a OK.
function effectiveHealth(systemHealth, generatedAtIso, maxAgeMinutes, nowMs) {
  if (!systemHealth || typeof systemHealth !== "object") {
    throw new Error("system_health ausente o malformado");
  }
  const state = systemHealth.state;
  if (state !== "OK" && state !== "OJO") {
    throw new Error(`Estado del sistema inválido: ${JSON.stringify(state)}`);
  }
  if (!Array.isArray(systemHealth.reasons)) {
    throw new Error("system_health.reasons debe ser una lista");
  }
  const reasons = systemHealth.reasons.slice();
  if (!reasons.every(isValidReason)) {
    throw new Error("system_health.reasons contiene motivos malformados");
  }
  if (state === "OJO" && reasons.length === 0) {
    throw new Error("OJO sin motivos: contrato inválido");
  }
  const minutes = computeAgeMinutes(generatedAtIso, nowMs);
  const maxAge = Number(maxAgeMinutes || systemHealth.max_age_minutes || 60);
  return { state, reasons, minutes, maxAge };
}

function currentHealth() {
  const generated = DASH.generated_at || DASH.system_health?.generated_at;
  const maxAge = DASH.max_age_minutes || DASH.system_health?.max_age_minutes;
  return effectiveHealth(DASH.system_health, generated, maxAge, Date.now());
}

function renderHealth() {
  const health = currentHealth();
  const isOjo = health.state === "OJO";

  const chip = byId("health-chip");
  chip.classList.toggle("health-chip--ok", !isOjo);
  chip.classList.toggle("health-chip--ojo", isOjo);
  byId("health-chip-state").textContent = health.state;

  // Popover: sólo se ve al abrirlo; el chip nunca muestra el texto completo.
  const badge = byId("health-pop-badge");
  badge.textContent = health.state;
  badge.className = `health-popover__badge health-popover__badge--${isOjo ? "ojo" : "ok"}`;
  // Contador agregado de acciones pendientes (sin contenido): sólo totales.
  const actions = (DASH.system_health && DASH.system_health.pending_actions) || null;
  const totalActions = actions ? actions.total || 0 : 0;
  const countReasons = health.reasons.length;
  byId("health-pop-count").textContent = !isOjo
    ? "Todo actualizado"
    : totalActions > 0
      ? `${totalActions} ${totalActions === 1 ? "acción pendiente" : "acciones pendientes"}`
      : `${countReasons} ${countReasons === 1 ? "incidencia" : "incidencias"}`;
  const reasons = byId("health-pop-reasons");
  // Motivos que YA están resumidos en la línea de contadores: no se repiten.
  const pendingCodes = ["PENDING_EVENT", "PENDING_LINK", "PENDING_MEDIA", "PACKAGE_ERROR"];
  const lines = [];
  if (isOjo && actions && totalActions > 0) {
    const parts = [];
    if (actions.reports) parts.push(`${actions.reports} reporte${actions.reports === 1 ? "" : "s"}`);
    if (actions.links)
      parts.push(`${actions.links} vinculación${actions.links === 1 ? "" : "es"}`);
    if (actions.media)
      parts.push(`${actions.media} archivo${actions.media === 1 ? "" : "s"} multimedia`);
    if (actions.technical)
      parts.push(`${actions.technical} problema${actions.technical === 1 ? "" : "s"} técnico`);
    // Un paquete de entrada que falló tiene su propia categoría: sin ella el
    // contador decía «1 acción pendiente» y el detalle quedaba vacío.
    if (actions.packages)
      parts.push(
        `${actions.packages} paquete${actions.packages === 1 ? "" : "s"} de entrada con error`,
      );
    lines.push(`<li>${escapeHtml(parts.join(" · "))}</li>`);
  }
  if (isOjo) {
    for (const reason of health.reasons) {
      if (!pendingCodes.includes(reason.code)) lines.push(`<li>${escapeHtml(reason.message)}</li>`);
    }
  }
  reasons.innerHTML = lines.join("");
  reasons.hidden = !isOjo;
  const updated = formatDateTime(DASH.generated_at, DASH.timezone);
  const age = ageText(health.minutes);
  byId("health-pop-updated").textContent = updated;
  byId("health-pop-age").textContent = age;

  // Meta compacta de la topbar (se refresca con el reloj de antigüedad).
  const campaign = String(DASH.campaign?.operational_start || DASH.campaign?.code || "2026").slice(0, 4);
  setText("topbar-campaign", campaign);
  setText("topbar-updated", updated);
  setText("topbar-age", age);
}

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = value;
}

function openHealthPopover() {
  byId("health-popover").hidden = false;
  byId("health-chip").setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onHealthOutside, true);
  document.addEventListener("keydown", onHealthKey);
}

function closeHealthPopover() {
  const pop = byId("health-popover");
  if (pop.hidden) return;
  pop.hidden = true;
  byId("health-chip").setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onHealthOutside, true);
  document.removeEventListener("keydown", onHealthKey);
}

function toggleHealthPopover() {
  if (byId("health-popover").hidden) openHealthPopover();
  else closeHealthPopover();
}

function onHealthOutside(event) {
  if (!byId("health").contains(event.target)) closeHealthPopover();
}

function onHealthKey(event) {
  if (event.key === "Escape") {
    closeHealthPopover();
    byId("health-chip").focus();
  }
}

function initHealth() {
  byId("health-chip").addEventListener("click", toggleHealthPopover);
}

function startAgeClock() {
  if (AGE_TIMER) window.clearInterval(AGE_TIMER);
  AGE_TIMER = window.setInterval(renderHealth, 60000);
}

/* ------------------------------------------------------------- resumen --- */

// Estados de ausencia de información: se muestran como estado secundario,
// notablemente más chicos que los números, sin sustituirse por cero.
const ABSENCE_STATES = new Set([
  "—",
  "SIN RECUENTO",
  "SIN REGISTROS",
  "SIN DATO",
  "SIN CONTROL",
  "SIN CONTROL RECIENTE",
  "SIN CURVA",
  "SIN CURVA CARGADA",
  "SIN BASE IMPORTADA",
  "NO INFORMADO",
  "NO REPORTADO",
  "NO DETERMINADO",
  "RIESGO NO DETERMINADO",
  "PENDIENTE",
]);

function isAbsenceState(value) {
  if (typeof value !== "string") return false;
  const text = value.trim().toUpperCase();
  return ABSENCE_STATES.has(text) || text.startsWith("SIN ");
}

function valueClass(base, value) {
  return isAbsenceState(value) ? `${base} is-absent` : base;
}

// Clase para elementos sin clase base (celdas de tabla, dd) cuando su valor es
// un estado de ausencia: se muestran notablemente más chicos que los números.
function absentClass(value) {
  return isAbsenceState(value) ? "is-absent" : "";
}

// Enlace estable al reporte oficial de INIA-GRAS (nunca la imagen diaria).
const INIA_CHILL_URL = "https://inia.uy/gras/Aplicaciones_y_recursos/Prevision%20Corderos";

function iniaLink() {
  return (
    `<a class="inia-link" href="${INIA_CHILL_URL}" target="_blank" rel="noopener noreferrer">` +
    `Ver reporte oficial del Chill Index de INIA</a>`
  );
}

function metricCard(label, value, note, opts = {}) {
  const cls = ["stat"];
  if (opts.kpi) cls.push("stat--kpi");
  if (opts.accent) cls.push("stat--accent");
  return `
    <article class="${cls.join(" ")}">
      <span class="stat__label">${escapeHtml(label)}</span>
      <strong class="${valueClass("stat__value", value)}">${escapeHtml(value)}</strong>
      ${note ? `<span class="stat__note">${escapeHtml(note)}</span>` : ""}
    </article>`;
}

function absentOr(value, formatter) {
  return value === null || value === undefined ? "SIN RECUENTO" : formatter(value);
}

const LOT_LABEL = { INTENSIVO: "Intensivo", DOHNE: "Dohne", MA: "MA" };
const LOT_FULL_NAME = { INTENSIVO: "Intensivo", DOHNE: "Merino Dohne", MA: "Merino Australiano" };
const MILESTONE_SCOPE_CLASS = { INTENSIVO: "intensivo", DOHNE: "dohne", MA: "ma" };

function lotNames(codes) {
  return (codes || []).map((code) => LOT_LABEL[code] || code).join(", ");
}

// Tabla de indicadores productivos generados por el backend: nombre, valor,
// numerador/denominador y estado. Nada se recalcula en JavaScript; un
// indicador no calculable muestra su estado real, nunca cero.
function indicatorTable(items, caption) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `<p class="empty-note">SIN INDICADORES DISPONIBLES.</p>`;
  // Cada estado del contrato se muestra tal cual: un total PARCIAL por lotes
  // faltantes no es lo mismo que no tener recuento, y decir «SIN RECUENTO»
  // donde hay un lote informado ocultaría lo que sí se registró.
  const STATE_TEXT = {
    OK: "OK",
    NO_INFORMADO: "NO INFORMADO",
    PARCIAL: "PARCIAL",
    SIN_CALCULO: "SIN CÁLCULO",
    ESTIMADO: "ESTIMADO",
    SIN_RECUENTO: "SIN RECUENTO",
  };
  const stateText = (item) => STATE_TEXT[item.status] || "SIN RECUENTO";
  // Un porcentaje se lee bien con un decimal (91,3 %). Un cociente por animal
  // no: la prolificidad es 1,34 corderos por oveja preñada, y redondeada a
  // 1,3 pierde justo la precisión que la vuelve útil para comparar lotes.
  //
  // El «%» acompaña al número porque sin él la cifra cambia de significado. La
  // unidad de un cociente, en cambio, ya está dicha en el nombre del indicador
  // —«Prolificidad»— y repetirla en la columna sólo alarga la celda. Sigue
  // publicada en el contrato (`unit`) para quien la necesite.
  const fmtValue = (item) => {
    if (item.status !== "OK" || item.value === null || item.value === undefined) {
      return stateText(item);
    }
    if (item.unit === "%") return `${decimalFormatter.format(item.value)} %`;
    return ratioFormatter.format(item.value);
  };
  const fmtFraction = (item) => {
    const num = item.numerator === null || item.numerator === undefined ? "—" : formatNumberShort(item.numerator);
    const den = item.denominator === null || item.denominator === undefined ? "—" : formatNumberShort(item.denominator);
    return `${num} / ${den}`;
  };
  const rows = list
    .map((item) => {
      const state = stateText(item);
      const stateTone = item.status === "OK" ? "ok" : "pending";
      return `
      <tr>
        <td class="ind-label">${escapeHtml(item.label)}</td>
        <td class="num ${item.status === "OK" ? "" : "is-absent"}">${escapeHtml(fmtValue(item))}</td>
        <td class="num ind-fraction">${escapeHtml(fmtFraction(item))}<span class="ind-den">${escapeHtml(item.denominator_label || "")}</span></td>
        <td><span class="tag tag--${stateTone}">${escapeHtml(state)}</span></td>
      </tr>`;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table class="data-table ind-table">
        ${caption ? `<caption class="sr-only">${escapeHtml(caption)}</caption>` : ""}
        <thead><tr><th>Indicador</th><th class="num">Valor</th><th class="num">Numerador / Denominador</th><th>Estado</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function formatNumberShort(value) {
  return Number.isInteger(value) ? integerFormatter.format(value) : decimalFormatter.format(value);
}

/* El resumen NO publica indicadores productivos globales: los catorce viven en
 * la vista de cada sistema (`renderLot` → `indicatorTable` sobre
 * `productive_indicators.by_module`) y no se repiten acá. */
function renderResumen() {
  const view = byId("view-resumen");
  view.innerHTML = `
    <h1 id="title-resumen" class="sr-only">Campaña por lote</h1>
    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Por lote</p><h2>Los tres módulos</h2></div>
        <p>Tocá un lote para ver su detalle.</p>
      </div>
      <div class="lot-cards">${LOTS.map(distributionCard).join("")}</div>
    </section>

    ${milestonesPanel(null)}

    <section class="panel" id="curva-general">
      <div class="panel__head">
        <div><p class="eyebrow">Curva integral</p><h2>Curva prevista, evolución real y mortalidad</h2></div>
        <p>Comparación entre la distribución prevista de partos, los registros reales acumulados y diarios, y la mortalidad informada durante la campaña.</p>
      </div>
      ${curvePanel("resumen", null)}
    </section>

    <section class="panel" id="chill-general">
      ${chillHead(null)}
      ${chillPanel("resumen", null)}
    </section>`;
}

function moduleByCode(code) {
  return (DASH.modules || []).find((m) => m.code === code) || null;
}

function dataState(module) {
  if (!module) return "SIN DATO";
  return module.ewe_counts?.counted_lambed === null ? "SIN RECUENTO" : "ACTUALIZADO";
}

/* Fechas OPERATIVAS de la tarjeta: la del hecho reportado y la del recuento
 * físico. Nunca una fecha técnica (generación del tablero, publicación,
 * procesamiento del mensaje) ni una fecha de otro módulo. */

// Fecha del último reporte válido de muerte —de corderos o de ovejas— del
// módulo. El backend publica el máximo `occurred_on` de los eventos de baja
// contabilizados del lote: es la fecha del hecho, no la del mensaje.
function lastMortalityReportDate(module) {
  return module ? module.mortality?.last_report_date || null : null;
}

// Fecha del último RECUENTO FÍSICO aceptado del módulo. Sus dos únicos orígenes
// son el conteo de corderos vivos de una recorrida
// (`lamb_counts.current_stock_count_date`) y el control acumulado de ovejas
// paridas informado desde el campo (`field_control.reported_date`); vale el más
// reciente. La fecha de recuento publicada dentro de `ewe_counts` no sirve:
// avanza con los partes diarios posteriores, que son reportes de parto y no un
// recuento físico.
function lastPhysicalCountDate(module) {
  if (!module) return null;
  const candidates = [
    module.lamb_counts?.current_stock_count_date,
    module.field_control?.reported_date,
  ].filter((value) => typeof value === "string" && ISO_DATE_RE.test(value.slice(0, 10)));
  if (!candidates.length) return null;
  return candidates.reduce((latest, value) => (value > latest ? value : latest));
}

function distributionCard(lot) {
  const module = moduleByCode(lot.code);
  // La ausencia se dice con palabras, no con un guión: la misma convención que
  // el resto del tablero. Antes convivían en la MISMA tarjeta «SIN RECUENTO»
  // (paridas, vivos) y «—» (muertes, avances, fechas), y el guión se pintaba
  // como si fuera un valor. Cada celda usa el término canónico de SU dato: sin
  // eventos es SIN REGISTROS, sin recuento es SIN RECUENTO, y lo que se deriva
  // del recuento inexistente queda SIN CÁLCULO. Un cero conocido sigue siendo
  // «0»: esto sólo cubre null.
  const conPalabra = (value, formatter, ausente) =>
    value === null || value === undefined ? ausente : formatter(value);
  const previsto = module ? formatInteger(module.ewe_counts.expected_to_lamb) : "—";
  const paridas = module ? absentOr(module.ewe_counts.counted_lambed, formatInteger) : "—";
  // El stock vivo y la reconstrucción son dos cifras distintas: la tarjeta
  // muestra las dos y no llama «nacidos» a los corderos que están vivos.
  const vivos = module ? absentOr(module.lamb_counts.current_stock_lambs, formatInteger) : "—";
  const nacidos = module
    ? conPalabra(module.lamb_counts.estimated_born_lambs, formatInteger, "SIN CÁLCULO")
    : "—";
  const muertos = module
    ? conPalabra(module.mortality.lamb_deaths_accumulated, formatInteger, "SIN REGISTROS")
    : "—";
  const ovejasMuertas = module
    ? conPalabra(module.mortality.ewe_deaths_accumulated, formatInteger, "SIN REGISTROS")
    : "—";
  const progress = module
    ? conPalabra(module.ewe_counts.progress?.percent, formatPercent, "SIN RECUENTO")
    : "—";
  const lambProgress = module
    ? conPalabra(module.lamb_counts.progress?.percent, formatPercent, "SIN CÁLCULO")
    : "—";
  const mortalityReportDate = conPalabra(
    lastMortalityReportDate(module), formatDayMonthYear, "SIN REGISTROS",
  );
  const physicalCountDate = conPalabra(
    lastPhysicalCountDate(module), formatDayMonthYear, "SIN RECUENTO",
  );
  const bornEstimateHelp =
    "Último recuento físico de corderos vivos más todos los corderos muertos acumulados de la campaña.";
  const cell = (label, value, help = null) =>
    `<div><dt${help ? ` title="${escapeHtml(help)}"` : ""}>${escapeHtml(label)}${
      help ? `<span class="sr-only">. ${escapeHtml(help)}</span>` : ""
    }</dt><dd class="${absentClass(value)}">${escapeHtml(value)}</dd></div>`;
  return `
    <a class="lot-card" href="#${lot.section}">
      <span class="lot-card__name">${escapeHtml(lot.name)}</span>
      ${lot.breed ? `<span class="lot-card__breed">${escapeHtml(lot.breed)}</span>` : ""}
      <dl class="lot-card__stats">
        ${cell("Preñadas a parir", previsto)}
        ${cell("Paridas", paridas)}
        ${cell("Vivos contabilizados", vivos)}
        ${cell("Corderos nacidos", nacidos, bornEstimateHelp)}
        ${cell("Muerte de corderos", muertos)}
        ${cell("Muerte de ovejas", ovejasMuertas)}
        ${cell("Avance ovejas", progress)}
        ${cell("Avance de corderos", lambProgress)}
      </dl>
      <dl class="lot-card__dates">
        <div>
          <dt>Último reporte de mortandad:</dt>
          <dd class="${absentClass(mortalityReportDate)}">${escapeHtml(mortalityReportDate)}</dd>
        </div>
        <div>
          <dt>Último recuento:</dt>
          <dd class="${absentClass(physicalCountDate)}">${escapeHtml(physicalCountDate)}</dd>
        </div>
      </dl>
    </a>`;
}

/* ------------------------------------------- hitos y observaciones (§5) --- */

// Sólo eventos estructurados y normalizados. El texto original, el remitente y
// cualquier comentario libre quedan en la gestión privada: acá se compone la
// línea a partir de campos cerrados (tipo, subtipo, cantidad, animal).
function milestoneLine(item) {
  const parts = [];
  if (item.module_code) parts.push(LOT_FULL_NAME[item.module_code] || item.module_code);
  const title = item.subtype_label || item.kind_label;
  let text = title;
  if (item.kind === "CONTROL_DE_CAMPO") {
    const pieces = [];
    if (item.counted_ewes_lambed !== null && item.counted_ewes_lambed !== undefined) {
      pieces.push(`${formatInteger(item.counted_ewes_lambed)} ovejas paridas`);
    }
    if (item.counted_live_lambs !== null && item.counted_live_lambs !== undefined) {
      // «Contabilizados», no «nacidos»: un CONTROL_DE_CAMPO es un recuento
      // FÍSICO de los animales vivos presentes ese día. No son nacimientos
      // registrados uno por uno, y describirlos así prometía una trazabilidad
      // individual que el recuento no tiene. El resto de los hitos —mortalidad,
      // incidencias, inicio de parición— sí viene de eventos individuales y
      // conserva su terminología: acá no se reemplaza nada en bloque.
      pieces.push(`${formatInteger(item.counted_live_lambs)} corderos vivos contabilizados`);
    }
    if (pieces.length) text = `${title}: ${pieces.join(" y ")}`;
  } else if (item.quantity !== null && item.quantity !== undefined) {
    const animal = item.animal_label ? ` ${item.animal_label}` : "";
    text = `${title}: ${formatInteger(item.quantity)}${animal}`;
  }
  if (item.cause_label) text = `${text} · ${item.cause_label}`;
  return { scope: parts.join(" · "), text };
}

function milestonesPanel(lotCode) {
  const block = DASH.campaign_milestones || {};
  const all = Array.isArray(block.items) ? block.items : [];
  const items = lotCode ? all.filter((item) => item.module_code === lotCode) : all;
  const body = items.length
    ? `<ul class="milestones">${items
        .map((item) => {
          const line = milestoneLine(item);
          const scopeClass = MILESTONE_SCOPE_CLASS[item.module_code] || "";
          return `
        <li class="milestone milestone--${escapeHtml(String(item.kind).toLowerCase())}">
          <span class="milestone__date">${escapeHtml(formatDayMonth(item.date))}</span>
          ${
            line.scope
              ? `<span class="milestone__scope${scopeClass ? ` milestone__scope--${scopeClass}` : ""}">${escapeHtml(line.scope)}</span>`
              : ""
          }
          <span class="milestone__text">${escapeHtml(line.text)}</span>
        </li>`;
        })
        .join("")}</ul>
      <p class="chart-note">Los hitos no modifican los recuentos: no suman ovejas paridas, corderos ni mortalidad.</p>`
    : `<p class="empty-note">SIN HITOS registrados para mostrar.</p>`;
  return `
    <section class="panel panel--flat">
      <div class="panel__head">
        <div><p class="eyebrow">Campaña</p><h2>Hitos y observaciones del día</h2></div>
        <p>Eventos estructurados, ordenados del más reciente al más antiguo.</p>
      </div>
      ${body}
    </section>`;
}

/* --------------------------------------------------------------- chill --- */

/* Bloque público del Chill Index, en dos secciones que nunca se mezclan:
 *   A. lo PREVISTO por la curva  (base EXPECTED)
 *   B. lo REGISTRADO por fecha   (base DAILY)
 * El Chill Index no predice muertes: acá no se habla de mortalidad. */

/* Título del bloque. NO se usa `chill_public.title` del contrato porque anuncia
 * «riesgo previsto», que es justamente lo que dejó de mostrarse.
 *
 * Tiene DOS formas y no es cosmético cuál se usa: el título anuncia el
 * contenido del panel. El bloque de nacimientos sólo se dibuja para el lote de
 * `CHILL_72H_MODULE` y sólo si tiene distribución diaria; en Intensivo y en
 * Dohne no se dibuja nunca. Prometerlo ahí dejaba el panel con un título que
 * hablaba de nacimientos y un cuerpo vacío debajo: no faltaba un dato, faltaba
 * el bloque entero, y desde afuera se leía como una pantalla rota. */
const CHILL_TITLE = "Chill Index diario";
const CHILL_TITLE_CON_NACIMIENTOS = "Chill Index diario y nacimientos registrados";

const CHILL_STATE = {};

function defaultChillState(lotCode) {
  return {
    lot: lotCode || "TODOS",
    selectedDate: null,
  };
}

function chillState(viewKey, lotCode) {
  if (!CHILL_STATE[viewKey]) CHILL_STATE[viewKey] = defaultChillState(lotCode);
  return CHILL_STATE[viewKey];
}

function matchesChillLot(state, code) {
  return state.lot === "TODOS" || state.lot === code;
}

/* El lote es el unico filtro que queda. Las filas se leen enteras del
 * contrato, sin recalcular nada. */
function chillObservedRows(state) {
  const rows = ((DASH.chill_public || {}).observed || {}).daily || [];
  return rows.filter((row) => matchesChillLot(state, row.module_code));
}

// El encabezado se queda con el título y el subtítulo. Los tres párrafos
// explicativos describen la ESTIMACIÓN por curva, no el pronóstico diario: se
// muestran junto al bloque previsto, para que las tarjetas diarias queden
// primero.
/* Se mira el dato publicado, no el estado del filtro: el título se dibuja una
 * vez y el cuerpo se redibuja al filtrar. Si dependiera del filtro, filtrar por
 * fecha cambiaría el título del panel. */
function chillAnunciaNacimientos(lotCode) {
  if (lotCode && lotCode !== CHILL_72H_MODULE) return false;
  const daily = ((DASH.chill_public || {}).observed || {}).daily || [];
  return daily.some((row) => row.module_code === CHILL_72H_MODULE);
}

function chillHead(lotCode) {
  const scope = lotCode ? ` — ${LOT_FULL_NAME[lotCode] || lotCode}` : "";
  const title = chillAnunciaNacimientos(lotCode) ? CHILL_TITLE_CON_NACIMIENTOS : CHILL_TITLE;
  return `
      <div class="panel__head">
        <div>
          <p class="eyebrow">Chill Index</p>
          <h2>${escapeHtml(title)}${escapeHtml(scope)}</h2>
        </div>
      </div>`;
}

function chillFilters(viewKey, lotCode, state) {
  if (lotCode) return "";
  return `
    <div class="chart-filters">
      <label class="filter">
        <span>Lote</span>
        <select data-chill="${escapeHtml(viewKey)}" data-filter="lot">
          <option value="TODOS">Todos los lotes</option>
          ${LOTS.map(
            (lot) =>
              `<option value="${lot.code}" ${state.lot === lot.code ? "selected" : ""}>${escapeHtml(lot.name)}</option>`,
          ).join("")}
        </select>
      </label>
    </div>`;
}

// Etiqueta relativa del día: HOY / MAÑANA / AYER o el día de la semana.
function dayRelative(dateString) {
  const [y, m, d] = (dateString || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return "HOY";
  if (diff === 1) return "MAÑANA";
  if (diff === -1) return "AYER";
  return new Intl.DateTimeFormat("es-UY", { weekday: "short" })
    .format(target)
    .replace(".", "")
    .toUpperCase();
}

/* --- B. Bloque OBSERVADO --------------------------------------------- */

/* Único módulo habilitado para el bloque de 72 h.
 *
 * Decisión del responsable (2026-08-07): Merino Australiano es el ÚNICO lote
 * que puede mostrarlo. Intensivo y Merino Dohne no lo muestran NUNCA, tengan o
 * no registros diarios algún día.
 *
 * La condición anterior era sólo «¿hay filas?». Alcanzaba para que hoy ninguno
 * lo dibujara, pero era demasiado genérica: el primer parte diario de Intensivo
 * o de Dohne lo habría hecho aparecer sin que nadie lo decidiera. */
const CHILL_72H_MODULE = "MA";

/* Filas del bloque de 72 h: las del lote en foco Y del módulo habilitado.
 *
 * Las dos condiciones son necesarias y ninguna reemplaza a la otra:
 *   - el módulo, porque la funcionalidad es exclusiva de Merino Australiano;
 *   - las filas, porque el bloque cruza cada cordero con el riesgo climático de
 *     los tres días siguientes a su nacimiento y para eso necesita la
 *     distribución diaria. Un recuento acumulado dice cuántos hay, no cuándo
 *     nacieron: sin distribución no hay nada que cruzar. */
function chillObserved72hRows(state) {
  return chillObservedRows(state).filter((row) => row.module_code === CHILL_72H_MODULE);
}

/* Nacimientos registrados y sus primeras 72 horas.
 *
 * Antes, sin filas, se dibujaba igual el título y dos avisos explicando que no
 * había datos. Ocupaba una sección entera para decir que no tenía nada que
 * decir. Ahora el bloque simplemente no existe salvo que Merino Australiano
 * tenga registros diarios reales, y entonces se arma con esos datos.
 *
 * Quien decide si el panel ANUNCIA este bloque es `chillAnunciaNacimientos`: el
 * título no puede prometer «y nacimientos registrados» en un lote donde este
 * bloque no se dibuja. */
function chillObservedSection(viewKey, state) {
  const observed = (DASH.chill_public || {}).observed || {};
  const rows = chillObserved72hRows(state);
  if (!rows.length) return "";

  // Visualización simple por fecha: altura proporcional a los nacidos y color
  // según el riesgo máximo de sus primeras 72 horas.
  const peak = Math.max(...rows.map((row) => Number(row.born_lambs) || 0), 1);
  const bars = rows
    .map((row) => {
      const born = Number(row.born_lambs) || 0;
      const height = Math.max(6, Math.round((born / peak) * 100));
      const label =
        `${formatDayMonth(row.date)} · ${LOT_LABEL[row.module_code] || row.module_code} · ` +
        `${formatInteger(row.born_lambs)} corderos · ${riskLabel(row.max_risk)}`;
      return `
      <button type="button" class="obs-bar risk-${escapeHtml(riskClass(row.max_risk))}"
        data-chill="${escapeHtml(viewKey)}" data-obsdate="${escapeHtml(row.date)}"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        <span class="obs-bar__fill" style="height:${height}%"></span>
        <span class="obs-bar__value">${escapeHtml(formatInteger(row.born_lambs))}</span>
        <span class="obs-bar__date">${escapeHtml(formatDayMonth(row.date))}</span>
      </button>`;
    })
    .join("");

  // Resumen por riesgo de los corderos REALMENTE registrados en las filas
  // visibles. Cada cordero entra en una sola categoría.
  const totals = {};
  for (const cat of [...RISK_ORDER, INCOMPLETE_RISK]) totals[cat] = 0;
  let counted = 0;
  for (const row of rows) {
    const born = Number(row.born_lambs) || 0;
    const bucket = totals[row.max_risk] === undefined ? INCOMPLETE_RISK : row.max_risk;
    totals[bucket] += born;
    counted += born;
  }
  const summary = [...RISK_ORDER, INCOMPLETE_RISK]
    .map(
      (cat) => `
      <div class="expo-cell expo-cell--${escapeHtml(riskClass(cat))}">
        <span class="expo-cell__label">${escapeHtml(cat === INCOMPLETE_RISK ? "EVALUACIÓN AMBIENTAL TODAVÍA INCOMPLETA" : riskLabel(cat))}</span>
        <strong>${escapeHtml(formatInteger(totals[cat]))}</strong>
      </div>`,
    )
    .join("");

  const detail = chillObservedDetail(state, rows);
  return `
    <section class="chill-section chill-section--observed">
      <h3 class="chill-section__title">${escapeHtml(observed.title || "")}</h3>
      <p class="chill-mode">Corderos nacidos registrados por fecha</p>
      <div class="obs-chart">${bars}</div>
      <p class="chart-note">Tocá una fecha para ver el detalle de sus primeras 72 horas.</p>
      ${detail}
      <p class="chill-mode">Corderos registrados por nivel de riesgo — ${escapeHtml(formatInteger(counted))} en total, cada uno contado una sola vez</p>
      <div class="expo-grid">${summary}</div>
    </section>`;
}

function chillObservedDetail(state, rows) {
  const row = rows.find((item) => item.date === state.selectedDate) || null;
  if (!row) return "";
  const cell = (label, value) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${absentClass(value)}">${escapeHtml(value)}</dd></div>`;
  const num = (value) => (value === null || value === undefined ? "NO INFORMADO" : formatInteger(value));
  return `
    <dl class="control-grid obs-detail">
      ${cell("Fecha", formatDate(row.date))}
      ${cell("Lote", LOT_FULL_NAME[row.module_code] || row.module_code)}
      ${cell("Servicio", row.service_type || "Sin servicio asociado")}
      ${cell("Ovejas paridas", num(row.ewes_lambed))}
      ${cell("Corderos nacidos", num(row.born_lambs))}
      ${cell("Nacidos vivos", num(row.born_alive))}
      ${cell("Nacidos muertos al parto", num(row.stillborn))}
      ${cell("Chill D", riskLabel(row.risk_d))}
      ${cell("Chill D+1", riskLabel(row.risk_d1))}
      ${cell("Chill D+2", riskLabel(row.risk_d2))}
      ${cell("Riesgo de las primeras 72 horas", riskLabel(row.max_risk))}
      ${cell("Evaluación", row.complete ? "Completa" : INCOMPLETE_RISK_LABEL)}
      ${cell("Estado de validación", row.validation_status)}
    </dl>`;
}

/* --- Panel completo --------------------------------------------------- */

/* Orden del bloque: primero el pronóstico diario —lo operativo inmediato—, y
 * después la estimación por curva y los nacimientos registrados. El pronóstico
 * queda FUERA del cuerpo que se redibuja: no depende de los controles, así que
 * no tiene por qué volver a dibujarse al filtrar. */
function chillPanel(viewKey, lotCode) {
  const chill = DASH.chill_public || {};
  const state = chillState(viewKey, lotCode);
  const stale = chill.update_status && chill.update_status.stale;
  return `
    ${stale ? `<p class="tag tag--incompleto">El Chill Index no está actualizado.</p>` : ""}
    ${chillIndexSection()}
    ${chillSourceNote()}
    ${chillFilters(viewKey, lotCode, state)}
    <div id="chill-body-${escapeHtml(viewKey)}">
      ${chillObservedSection(viewKey, state)}
    </div>`;
}

/* Atribución: INIA-GRAS es la fuente METEOROLÓGICA del pronóstico diario. Los
 * nacimientos registrados que siguen en el bloque son partes de campo de
 * CICOMA y no deben atribuirse a INIA. El enlace es el oficial que ya existía;
 * no se agregan enlaces nuevos. */
function chillSourceNote() {
  return `
    <p class="chill-source">Fuente meteorológica oficial: INIA-GRAS · ${iniaLink()}<br />
      Los nacimientos registrados provienen de los partes de campo de CICOMA.</p>`;
}

/* ------------------------------------- pronóstico diario (pipeline propio) --- */

//: Etiqueta pública de cada categoría. `NO_DETERMINADO` no se rotula como
//: riesgo: la tarjeta correspondiente dice «Sin datos».
const RISK_LABEL = {
  SIN_RIESGO: "Sin riesgo",
  BAJO: "Bajo",
  MEDIO: "Medio",
  ALTO: "Alto",
  // `MUY_ALTO` es el identificador INTERNO del contrato para el rango >1200.
  // La escala pública de INIA lo llama CRÍTICO y es el texto que ve el
  // productor: un mismo rango no puede tener dos nombres. No se migra el
  // contrato, se traduce acá.
  MUY_ALTO: "Crítico",
};

//: Motivo técnico traducido. El público ve sólo «Sin datos» o «Error»; el
//: motivo acompaña como nota, sin exponer detalle sensible.
const NO_DATA_REASON = {
  WRF_UNDEFINED_GRID: "INIA publicó el mapa sin grilla utilizable",
  SOURCE_DATE_UNVERIFIED: "No se pudo verificar que la corrida sea vigente",
  MAP_NOT_PUBLISHED: "INIA no publicó el mapa de esa fecha",
  FORECAST_EXPIRED: "La fecha del pronóstico ya pasó",
  WRF_MINI_ONLY: "Sólo hay miniatura, que no habilita una categoría",
};

//: Fallas técnicas. Se ven en negro como «Sin datos», pero son otra cosa: acá
//: el problema es nuestro o de la red, no de la fuente que no tiene datos.
const ERROR_REASON = {
  SOURCE_TIMEOUT: "La fuente no respondió a tiempo",
  SOURCE_HTTP_403: "La fuente rechazó la consulta",
  SOURCE_HTTP_404: "Respuesta inesperada de la fuente",
  SOURCE_HTTP_429: "La fuente limitó las consultas",
  SOURCE_HTTP_5XX: "La fuente devolvió un error",
  CORRUPT_IMAGE: "La imagen recibida no se pudo leer",
  INVALID_DIMENSIONS: "La imagen no tiene las dimensiones esperadas",
  CLASSIFICATION_ERROR: "No se pudo clasificar el mapa",
  CONTRACT_VALIDATION_ERROR: "El resultado no superó la validación",
  PUBLICATION_ERROR: "No se pudo publicar el resultado",
};

//: Reintentos de la lectura del contrato del Chill. El publicador hace varios
//: commits por ciclo y CADA uno dispara una reconstrucción de GitHub Pages, así
//: que una petición puede caer justo en el cambio de despliegue y fallar sola:
//: el `?t=` la vuelve única, con lo que nunca la sirve la caché de borde y
//: siempre depende del origen. Tres intentos cortos cubren esa ventana. No
//: enmascaran nada: si los tres fallan, se dice, y el motivo queda a la vista.
const CHILL_FETCH_ATTEMPTS = 3;
const CHILL_RETRY_DELAY_MS = 400;

//: Motivo del último fallo de carga, para no confundir «no pudimos leerlo» con
//: «no hay pronóstico»: son cosas distintas y sólo la primera es un problema
//: nuestro.
let CHILL_INDEX_ERROR = null;

function chillRetryPause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadChillIndex() {
  CHILL_INDEX = null;
  CHILL_INDEX_ERROR = null;
  for (let intento = 1; intento <= CHILL_FETCH_ATTEMPTS; intento += 1) {
    try {
      const response = await fetch(`${CHILL_INDEX_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      CHILL_INDEX = await response.json();
      CHILL_INDEX_ERROR = null;
      return;
    } catch (error) {
      // El error se conserva y se registra en consola: un fallo silencioso deja
      // el bloque en rojo sin ninguna pista de por qué.
      CHILL_INDEX_ERROR = error;
      console.error(`Chill Index: intento ${intento}/${CHILL_FETCH_ATTEMPTS} falló`, error);
      if (intento < CHILL_FETCH_ATTEMPTS) await chillRetryPause(CHILL_RETRY_DELAY_MS * intento);
    }
  }
}

function chillDayCard(map) {
  const fecha = formatDate(map.valid_date);
  const legible = new Intl.DateTimeFormat("es-UY", { day: "numeric", month: "long" }).format(
    new Date(`${map.valid_date}T12:00:00`),
  );
  // Estado de la fecha. `SIN_DATOS` y `ERROR` comparten el negro —ninguno es una
  // categoría de riesgo— pero conservan clases y textos distintos: uno dice que
  // la fuente no tiene el dato, el otro que no pudimos obtenerlo.
  const disponibilidad = map.availability_status || map.display_status;
  if (disponibilidad === "ERROR") {
    const motivo = ERROR_REASON[map.reason_code] || "No se pudo obtener el dato";
    return `
      <article class="forecast-card forecast-card--error"
               role="listitem"
               aria-label="Pronóstico Chill Index para el ${escapeHtml(legible)}: error al obtener los datos.">
        <span class="forecast-card__date">${escapeHtml(fecha)}</span>
        <strong class="forecast-card__value">Error</strong>
        <span class="forecast-card__note">${escapeHtml(motivo)}</span>
      </article>`;
  }
  if (disponibilidad !== "DISPONIBLE") {
    const motivo = NO_DATA_REASON[map.reason_code] || "Sin información verificable";
    return `
      <article class="forecast-card forecast-card--no-data"
               role="listitem"
               aria-label="Pronóstico Chill Index para el ${escapeHtml(legible)}: sin datos disponibles.">
        <span class="forecast-card__date">${escapeHtml(fecha)}</span>
        <strong class="forecast-card__value">Sin datos</strong>
        <span class="forecast-card__note">${escapeHtml(motivo)}</span>
      </article>`;
  }
  const etiqueta = RISK_LABEL[map.risk_category] || map.risk_category;
  const intervalo =
    map.ci_min === null && map.ci_max === null
      ? ""
      : map.ci_min === null
        ? `&lt; ${formatInteger(map.ci_max)}`
        : map.ci_max === null
          ? `&gt; ${formatInteger(map.ci_min)}`
          : `${formatInteger(map.ci_min)}–${formatInteger(map.ci_max)}`;
  return `
    <article class="forecast-card forecast-card--${escapeHtml(map.risk_category.toLowerCase())}"
             role="listitem"
             aria-label="Pronóstico Chill Index para el ${escapeHtml(legible)}: riesgo ${escapeHtml(etiqueta)}.">
      <span class="forecast-card__date">${escapeHtml(fecha)}</span>
      <strong class="forecast-card__value">${escapeHtml(etiqueta)}</strong>
      <span class="forecast-card__note">${intervalo ? `${intervalo} ${escapeHtml(map.ci_unit)}` : ""}</span>
    </article>`;
}

/* Vigencia del pronóstico, decidida por el CONTRATO y no por la etiqueta que el
 * pipeline congeló al correr. `status_label` se genera en la corrida y puede
 * decir «actualizado hoy» cuando lo único de hoy fue la verificación: la única
 * fuente confiable de vigencia son `forecast_run_date` y `freshness`.
 *
 *   A · corrida válida de hoy             -> actualizado
 *   B · se verificó hoy, corrida anterior -> se muestra su fecha real y la edad
 *   C · sin corrida válida                -> se dice, sin fingir que hay dato
 */
function chillFreshness(d) {
  const f = d.freshness || {};
  const dias = typeof f.last_valid_age_days === "number" ? f.last_valid_age_days : null;
  const corrida = f.last_valid_forecast_run_date || d.forecast_run_date || null;
  if (!corrida) {
    return {
      tono: "bad",
      titular: "Sin pronóstico válido disponible",
      detalle: "La última consulta a INIA-GRAS no dejó ninguna corrida utilizable.",
      dias: null,
    };
  }
  const fecha = formatDate(corrida);
  if (dias === 0) {
    return { tono: "ok", titular: `Pronóstico de INIA del ${fecha}`, detalle: null, dias: 0 };
  }
  const edad = dias === null ? "" : ` — hace ${dias} día${dias === 1 ? "" : "s"}`;
  return {
    tono: dias !== null && dias >= 2 ? "bad" : "warn",
    titular: `Última corrida válida de INIA: ${fecha}${edad}`,
    detalle: "Se verificó la fuente, pero INIA todavía no publicó una corrida nueva utilizable.",
    dias,
  };
}

function chillIndexSection() {
  if (!CHILL_INDEX) {
    // El motivo se muestra: sin él, un 404 de despliegue y una caída de red se
    // ven iguales, y nadie puede saber si el dato existe.
    const motivo = CHILL_INDEX_ERROR
      ? ` (${CHILL_INDEX_ERROR.message || String(CHILL_INDEX_ERROR)})`
      : "";
    return `
      <section class="chill-index" aria-labelledby="chill-index-title">
        <h3 id="chill-index-title">Chill Index diario</h3>
        <p class="chill-index__status chill-index__status--bad">
          No se pudo leer el pronóstico publicado por el pipeline${escapeHtml(motivo)}.
        </p>
      </section>`;
  }
  const d = CHILL_INDEX;
  const vig = chillFreshness(d);
  // Metadatos en orden de utilidad para el campo: vigencia y fecha del
  // pronóstico arriba; del detalle técnico sólo queda la última verificación,
  // que es lo que distingue «se miró» de «hay dato nuevo».
  // Verificar es que INIA haya ENTREGADO algo, no que el pipeline haya
  // terminado: una corrida que no bajó ningún cuerpo no verificó nada.
  const mirada = (d.freshness || {}).latest_source_seen || d.run_finished_at || null;
  const verificacion = mirada
    ? `<li>Última verificación de la fuente: ${escapeHtml(formatDateTime(mirada, DASH.timezone))}</li>`
    : "";
  return `
    <section class="chill-index" aria-labelledby="chill-index-title">
      <h3 id="chill-index-title">Chill Index diario</h3>
      <p class="chill-index__status chill-index__status--${vig.tono}">
        ${escapeHtml(vig.titular)}
      </p>
      ${vig.detalle ? `<p class="chill-index__detail">${escapeHtml(vig.detalle)}</p>` : ""}
      ${d.status_detail ? `<p class="chill-index__detail">${escapeHtml(d.status_detail)}</p>` : ""}
      <div class="forecast-grid" role="list">
        ${d.maps.map(chillDayCard).join("")}
      </div>
      <ul class="chill-index__meta">
        ${verificacion}
      </ul>
    </section>`;
}

function renderChillBody(viewKey, lotCode) {
  const host = byId(`chill-body-${viewKey}`);
  if (!host) return;
  const state = chillState(viewKey, lotCode);
  host.innerHTML = `
      ${chillObservedSection(viewKey, state)}`;
}

function onChillControl(event) {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.chill) return false;
  const viewKey = target.dataset.chill;
  const state = CHILL_STATE[viewKey];
  if (!state) return false;
  if (target.dataset.obsdate !== undefined) {
    state.selectedDate = state.selectedDate === target.dataset.obsdate ? null : target.dataset.obsdate;
  } else if (target.dataset.filter === "lot") {
    state.lot = target.value;
    state.selectedDate = null;
  } else {
    return false;
  }
  renderChillBody(viewKey, CODE_BY_SECTION[viewKey] || null);
  return true;
}

/* ------------------------------------------------------------ por lote --- */

/* ===================================================================
 * MERINO AUSTRALIANO — tablero operativo de parición
 * ===================================================================
 *
 * MA no se sigue como Intensivo y Dohne. Los otros dos lotes se informan por
 * partes agregados —«nacieron 6 corderos»— y su vista publica totales. En MA se
 * fotografía la libreta de nacimientos y cada fila es un animal con caravana,
 * así que acá se puede publicar lo que en los otros no existe: quién nació, de
 * qué madre y qué día.
 *
 * Todo lo que se dibuja sale de `DASH.ma_tracking`, que el backend reconstruye
 * en cada corrida desde `Lambing` y `Lamb`. Este archivo NO calcula acumulados
 * ni totaliza series: si lo hiciera habría dos verdades —la de la base y la del
 * navegador— y tarde o temprano dejarían de coincidir. Acá sólo se ordena y se
 * dibuja lo que ya viene calculado.
 */

//: Estado de la vista MA. Vive fuera del render porque el bloque se redibuja al
//: filtrar y no puede perder lo que la persona eligió.
//: Fichas por tanda. La lista se redibuja entera en cada tecla de la búsqueda,
//: y con la campaña entera eso es medio megabyte de HTML por pulsación: a 500
//: corderos son 323 KB y ~5000 nodos entre los que hay que rehacer el layout.
//: Con una tanda el costo por tecla deja de depender del tamaño de la campaña.
const MA_PAGINA = 60;

const MA_STATE = {
  serie: "corderos", // corderos | ovejas
  dias: {}, // fecha -> abierto
  busqueda: "",
  filtro: "TODOS",
  // Cuántas fichas se PINTAN. La búsqueda y los filtros siguen operando sobre
  // la lista completa: esto limita lo que se dibuja, no lo que se considera.
  visibles: MA_PAGINA,
};

function maTracking() {
  return DASH.ma_tracking || null;
}

//: ¿Este lote tiene seguimiento individual publicado? La pregunta es por el
//: DATO, no por el código del lote: el día que Dohne registre corderos
//: individuales, su bloque aparece sin tocar esta condición.
function maTieneSeguimiento(lotCode) {
  const t = maTracking();
  return Boolean(t && t.module_code === lotCode);
}

/* ------------------------------------------------------ indicadores --- */

/* Un valor que no se conoce no se dibuja como cero.
 *
 * En un tablero de parición «0 muertos» y «no sabemos cuántos murieron» llevan
 * a decisiones distintas, y la libreta no tiene columna de nacido muerto. Por
 * eso los indicadores principales sólo publican lo que se contó de verdad. */
function maIndicatorCard(label, value, hint) {
  const vacio = value === null || value === undefined;
  const texto = vacio ? "SIN INFORMAR" : formatInteger(value);
  return `
    <div class="ma-kpi${vacio ? " ma-kpi--empty" : ""}">
      <p class="ma-kpi__label">${escapeHtml(label)}</p>
      <p class="ma-kpi__value">${escapeHtml(texto)}</p>
      ${hint ? `<p class="ma-kpi__hint">${escapeHtml(hint)}</p>` : ""}
    </div>`;
}

function maIndicators(tracking) {
  const ind = tracking.indicators || {};
  const hoy = tracking.today ? formatDayMonth(tracking.today) : null;
  const cards = [
    maIndicatorCard("Ovejas paridas", ind.ewes_lambed, "Acumulado confirmado"),
    maIndicatorCard("Corderos nacidos", ind.born_lambs, "Acumulado confirmado"),
    maIndicatorCard("Paridas hoy", ind.ewes_today, hoy ? `Al ${hoy}` : null),
    maIndicatorCard("Nacidos hoy", ind.born_today, hoy ? `Al ${hoy}` : null),
    maIndicatorCard("Pendientes de revisión", ind.pending, "No suman al acumulado"),
    // Dos números que NO son lo mismo y que confundidos llevan a creer que no
    // falta nada: éste dice si hay fotos que nadie miró todavía; el de arriba,
    // si hay filas ya leídas esperando una decisión.
    maIndicatorCard(
      "Fotos pendientes de lectura",
      ind.pending_images,
      "Esperan procesamiento asistido",
    ),
  ].join("");

  // Dos fechas distintas que se confunden con facilidad: cuándo se cargó el
  // último registro y de qué día es la última parición. Se rotulan las dos.
  const meta = [];
  if (ind.last_birth_date) {
    meta.push(`Última parición registrada: ${formatDate(ind.last_birth_date, { short: true })}`);
  }
  if (ind.last_record_at) {
    meta.push(`Última incorporación: ${formatDateTime(ind.last_record_at, DASH.timezone)}`);
  }
  const identificados = ind.individualized_lambs || 0;
  const faltan = (ind.born_lambs || 0) - identificados;
  return `
    <div class="ma-kpis">${cards}</div>
    ${meta.length ? `<p class="ma-meta">${escapeHtml(meta.join(" · "))}</p>` : ""}
    ${
      faltan > 0
        ? `<p class="ma-alert">IDENTIFICACIÓN INDIVIDUAL INCOMPLETA — se declararon ${formatInteger(
            ind.born_lambs,
          )} nacidos y hay ${formatInteger(
            identificados,
          )} cordero(s) con caravana registrada. Los ${formatInteger(
            faltan,
          )} restantes no se inventan: falta identificarlos.</p>`
        : ""
    }`;
}

/* ---------------------------------------------------------- gráfica --- */

/* Barras del día y línea del acumulado, en el mismo par de ejes.
 *
 * Son dos magnitudes de escalas muy distintas —4 nacimientos en un día contra
 * 400 acumulados— así que comparten el eje horizontal y NO el vertical: cada
 * serie tiene su propia escala, rotulada de su lado. Dibujarlas contra un eje
 * común aplastaría las barras hasta volverlas invisibles.
 *
 * El selector CORDEROS/OVEJAS cambia la magnitud, no el tipo de gráfico: en
 * móvil dos gráficos apilados obligan a recordar el primero mientras se mira el
 * segundo, y son la misma pregunta hecha sobre otra unidad. */
function maChartSection(tracking) {
  if (!(tracking.daily || []).length) {
    return `
      <div class="ma-chart-empty">
        <p>Todavía no hay pariciones registradas en este lote.</p>
        <p class="ma-chart-empty__hint">La gráfica aparece con el primer nacimiento confirmado.</p>
      </div>`;
  }
  const serie = MA_STATE.serie;
  const boton = (clave, texto) =>
    `<button type="button" class="ma-toggle${serie === clave ? " is-active" : ""}" data-ma-serie="${clave}" aria-pressed="${serie === clave}">${escapeHtml(texto)}</button>`;
  return `
    <div class="ma-toggles" role="group" aria-label="Magnitud de la gráfica">
      ${boton("corderos", "Corderos")}
      ${boton("ovejas", "Ovejas")}
    </div>
    <div class="ma-chart-wrap">
      <canvas id="ma-chart" role="img" aria-label="Nacimientos por día y acumulado de la parición de Merino Australiano"></canvas>
    </div>
    <p class="ma-chart-legend">
      <span class="ma-legend ma-legend--bar"></span> ${escapeHtml(
        serie === "ovejas" ? "Ovejas paridas por día" : "Corderos nacidos por día",
      )}
      <span class="ma-legend ma-legend--line"></span> ${escapeHtml(
        serie === "ovejas" ? "Ovejas paridas acumuladas" : "Corderos nacidos acumulados",
      )}
      ${
        // La leyenda sólo aparece si hay al menos un valor previsto DIBUJABLE.
        // Con todas las fechas observadas anteriores al inicio de la curva, el
        // arreglo existe pero está lleno de nulos: anunciarla dejaría una
        // leyenda apuntando a algo que no está en la gráfica.
        (
          maExpectedCumulative(
            tracking,
            (tracking.daily || []).map((f) => f.date),
          ) || []
        ).some((v) => v !== null && v !== undefined)
          ? `<span class="ma-legend ma-legend--expected"></span> ${escapeHtml("Previsto por la curva del lote (referencia)")}`
          : ""
      }
    </p>`;
}

/* Acumulado PREVISTO en cada fecha observada, como referencia.
 *
 * La curva prevista del lote publica, por día, cuántas ovejas se esperaba que
 * parieran y cuántos corderos nacieran: las MISMAS magnitudes que la serie
 * observada, así que la comparación no engaña. Lo que sí engañaría es dibujar
 * la curva prevista entera —de agosto a octubre— junto a dos días observados:
 * el eje se estiraría hasta aplastar las barras. Por eso la referencia se
 * evalúa sólo en las fechas que la serie observada ya tiene, que es donde la
 * pregunta «¿vamos adelantados o atrasados?» tiene respuesta.
 *
 * Si el lote no tiene curva, no se dibuja nada: una referencia inventada sería
 * peor que ninguna. */
function maExpectedCumulative(tracking, fechas) {
  const lote = ((DASH.lambing_curves || {}).lots || []).find(
    (l) => l.code === tracking.module_code,
  );
  const puntos = (lote && lote.expected_original) || [];
  if (!puntos.length || !fechas.length) return null;
  const ovejas = MA_STATE.serie === "ovejas";
  const hasta = new Map();
  let acumulado = 0;
  for (const punto of puntos) {
    acumulado += Number(ovejas ? punto.expected_ewes : punto.expected_lambs) || 0;
    hasta.set(punto.date, acumulado);
  }
  // Una fecha observada anterior al inicio de la curva no tiene previsto: se
  // deja en blanco en vez de arrastrar el último valor conocido.
  let ultimo = null;
  const ordenadas = [...hasta.keys()].sort();
  return fechas.map((fecha) => {
    for (const clave of ordenadas) {
      if (clave <= fecha) ultimo = hasta.get(clave);
    }
    return fecha < ordenadas[0] ? null : Math.round(ultimo);
  });
}

function maChartSeries(tracking) {
  const ovejas = MA_STATE.serie === "ovejas";
  const filas = tracking.daily || [];
  const previsto = maExpectedCumulative(
    tracking,
    filas.map((f) => f.date),
  );
  return filas.map((fila, index) => ({
    date: fila.date,
    daily: ovejas ? fila.ewes : fila.born,
    cumulative: ovejas ? fila.cumulative_ewes : fila.cumulative_born,
    expected: previsto ? previsto[index] : null,
  }));
}

function drawMaChart() {
  const tracking = maTracking();
  const canvas = byId("ma-chart");
  if (!tracking || !canvas) return;
  const puntos = maChartSeries(tracking);
  const wrap = canvas.parentElement;
  if (!wrap || !puntos.length) return;

  const context = canvas.getContext("2d");
  const style = window.getComputedStyle(wrap);
  const inset = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
  const width = Math.max(240, Math.floor(wrap.clientWidth - inset));
  // Más baja en móvil: una gráfica que no entra en pantalla obliga a hacer
  // scroll para leer el eje, y entonces no se lee.
  const height = width < 480 ? 240 : 320;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { top: 18, right: 44, bottom: 34, left: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const slot = plotWidth / puntos.length;
  const maxDaily = Math.max(...puntos.map((p) => p.daily || 0), 1);
  const maxCumulative = Math.max(
    ...puntos.map((p) => Math.max(p.cumulative || 0, p.expected || 0)),
    1,
  );

  context.font = "11px Inter, system-ui, sans-serif";
  context.strokeStyle = "rgba(135, 135, 134, 0.28)";
  context.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (plotHeight / 4) * step;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
    const proporcion = (4 - step) / 4;
    context.fillStyle = "#878786";
    context.textAlign = "right";
    context.fillText(integerFormatter.format(Math.round(maxDaily * proporcion)), padding.left - 6, y + 4);
    context.textAlign = "left";
    context.fillStyle = "#1f6f5c";
    context.fillText(
      integerFormatter.format(Math.round(maxCumulative * proporcion)),
      padding.left + plotWidth + 6,
      y + 4,
    );
  }

  const anchoBarra = Math.max(4, Math.min(28, slot * 0.55));
  context.fillStyle = "#8fbf9f";
  puntos.forEach((punto, index) => {
    const valor = punto.daily || 0;
    if (valor <= 0) return;
    const alto = (valor / maxDaily) * plotHeight;
    const x = padding.left + slot * index + slot / 2 - anchoBarra / 2;
    context.fillRect(x, padding.top + plotHeight - alto, anchoBarra, alto);
  });

  // Referencia prevista: punteada y por debajo de la observada, para que se
  // lea como referencia y no como un segundo resultado.
  const conPrevisto = puntos.filter((p) => p.expected !== null && p.expected !== undefined);
  if (conPrevisto.length) {
    context.save();
    context.setLineDash([4, 4]);
    context.strokeStyle = "#8b9086";
    context.lineWidth = 1.5;
    context.beginPath();
    let iniciado = false;
    puntos.forEach((punto, index) => {
      if (punto.expected === null || punto.expected === undefined) return;
      const x = padding.left + slot * index + slot / 2;
      const y = padding.top + plotHeight - (punto.expected / maxCumulative) * plotHeight;
      if (!iniciado) {
        context.moveTo(x, y);
        iniciado = true;
      } else context.lineTo(x, y);
    });
    context.stroke();
    // Con una sola fecha, `stroke()` de un punto no dibuja NADA: la leyenda
    // anunciaría una referencia invisible. Cada punto lleva además su propia
    // marca, así que el primer día ya se ve dónde está lo previsto.
    context.setLineDash([]);
    puntos.forEach((punto, index) => {
      if (punto.expected === null || punto.expected === undefined) return;
      const x = padding.left + slot * index + slot / 2;
      const y = padding.top + plotHeight - (punto.expected / maxCumulative) * plotHeight;
      context.beginPath();
      context.moveTo(x - 5, y);
      context.lineTo(x + 5, y);
      context.stroke();
    });
    context.restore();
  }

  context.strokeStyle = "#1f6f5c";
  context.lineWidth = 2;
  context.beginPath();
  puntos.forEach((punto, index) => {
    const x = padding.left + slot * index + slot / 2;
    const y = padding.top + plotHeight - ((punto.cumulative || 0) / maxCumulative) * plotHeight;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  context.fillStyle = "#1f6f5c";
  puntos.forEach((punto, index) => {
    const x = padding.left + slot * index + slot / 2;
    const y = padding.top + plotHeight - ((punto.cumulative || 0) / maxCumulative) * plotHeight;
    context.beginPath();
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
  });

  // Con muchas fechas no entran todas las etiquetas: se saltean, pero la
  // primera y la última siempre se dibujan para que el rango quede claro.
  const paso = Math.max(1, Math.ceil(puntos.length / (width < 480 ? 4 : 8)));
  context.fillStyle = "#878786";
  context.textAlign = "center";
  puntos.forEach((punto, index) => {
    if (index % paso !== 0 && index !== puntos.length - 1) return;
    const x = padding.left + slot * index + slot / 2;
    context.fillText(formatDayMonth(punto.date), x, height - 12);
  });
}

/* ------------------------------------------------------- día a día --- */

function maDaySection(tracking) {
  const dias = [...(tracking.daily || [])].reverse();
  if (!dias.length) return `<p class="empty-note">Sin pariciones registradas todavía.</p>`;
  const registrosPorDia = new Map();
  for (const registro of tracking.records || []) {
    if (!registrosPorDia.has(registro.date)) registrosPorDia.set(registro.date, []);
    registrosPorDia.get(registro.date).push(registro);
  }
  return dias
    .map((dia) => {
      const abierto = Boolean(MA_STATE.dias[dia.date]);
      const registros = registrosPorDia.get(dia.date) || [];
      const partos = [];
      if (dia.simple) partos.push(`${formatInteger(dia.simple)} simple(s)`);
      if (dia.multiple) partos.push(`${formatInteger(dia.multiple)} múltiple(s)`);
      const sexos = [];
      if (dia.males) sexos.push(`${formatInteger(dia.males)} M`);
      if (dia.females) sexos.push(`${formatInteger(dia.females)} H`);
      if (dia.sex_unknown) sexos.push(`${formatInteger(dia.sex_unknown)} sin informar`);
      return `
      <article class="ma-day${abierto ? " is-open" : ""}">
        <button type="button" class="ma-day__head" data-ma-day="${escapeHtml(dia.date)}" aria-expanded="${abierto}">
          <span class="ma-day__date">${escapeHtml(formatDate(dia.date, { short: true }))}</span>
          <span class="ma-day__totals">${formatInteger(dia.ewes)} oveja(s) · ${formatInteger(dia.born)} cordero(s)</span>
          <span class="ma-day__chevron" aria-hidden="true"></span>
        </button>
        <dl class="ma-day__meta">
          ${partos.length ? `<div><dt>Partos</dt><dd>${escapeHtml(partos.join(" · "))}</dd></div>` : ""}
          ${sexos.length ? `<div><dt>Sexo</dt><dd>${escapeHtml(sexos.join(" · "))}</dd></div>` : ""}
          ${dia.pending ? `<div><dt>Pendientes</dt><dd>${formatInteger(dia.pending)}</dd></div>` : ""}
          <div><dt>Acumulado</dt><dd>${formatInteger(dia.cumulative_ewes)} ovejas · ${formatInteger(dia.cumulative_born)} corderos</dd></div>
        </dl>
        ${
          dia.identification_complete
            ? ""
            : `<p class="ma-day__warn">IDENTIFICACIÓN INDIVIDUAL INCOMPLETA — este día declara ${formatInteger(dia.born)} nacido(s) y tiene ${formatInteger(dia.individualized)} con caravana.</p>`
        }
        ${abierto ? `<div class="ma-day__rows">${registros.map(maRecordCard).join("")}</div>` : ""}
      </article>`;
    })
    .join("");
}

/* ------------------------------------------------- ficha de cordero --- */

//: Un dato ausente se rotula, no se rellena. `SIN INFORMAR` es una respuesta.
function maValue(value) {
  return value === null || value === undefined || value === "" ? "SIN INFORMAR" : String(value);
}

//: El estado viene del modelo (`ValidationStatus`) y no se publica crudo: quien
//: lee el tablero no tiene por qué saber qué significa `CORRECTED`.
const MA_STATUS_LABEL = {
  CONFIRMED: "Confirmado",
  CORRECTED: "Confirmado con corrección",
};

function maStatusLabel(status) {
  return MA_STATUS_LABEL[status] || maValue(status);
}

function maSexLabel(sex) {
  if (sex === "MACHO") return "Macho";
  if (sex === "HEMBRA") return "Hembra";
  return "Sexo sin informar";
}

function maRecordCard(registro) {
  const tipo = registro.birth_type > 1 ? `Múltiple (${registro.birth_type})` : "Simple";
  // La fotografía es la evidencia de la fila. NO se publica la imagen: se
  // publica que existe y con qué huella, para poder pedirla en Gestión, que es
  // donde además se corrige. Publicar las fotos de la libreta en un sitio
  // abierto es otra decisión y no se toma acá.
  const foto = registro.photo
    ? `<p class="ma-record__photo">FOTO DE LIBRETA · ${escapeHtml(registro.photo.sha256_short)}</p>`
    : "";
  const peso =
    registro.weight_kg === null || registro.weight_kg === undefined
      ? "SIN INFORMAR"
      : `${registro.weight_kg} kg`;
  return `
    <article class="ma-record">
      <header class="ma-record__head">
        <span class="ma-record__code">${escapeHtml(registro.code)}</span>
        <span class="ma-record__mother">Madre ${escapeHtml(maValue(registro.ewe_identifier))}</span>
      </header>
      <dl class="ma-record__grid">
        <div><dt>Fecha</dt><dd>${escapeHtml(formatDate(registro.date, { short: true }))}</dd></div>
        <div><dt>Sexo</dt><dd>${escapeHtml(maSexLabel(registro.sex))}</dd></div>
        <div><dt>Tipo de parto</dt><dd>${escapeHtml(tipo)}</dd></div>
        <div><dt>Peso al nacer</dt><dd>${escapeHtml(peso)}</dd></div>
        <div><dt>Observaciones</dt><dd>${escapeHtml(registro.has_notes ? "Registradas (ver en Gestión)" : "SIN INFORMAR")}</dd></div>
        <div><dt>Estado</dt><dd>${escapeHtml(maStatusLabel(registro.status))}</dd></div>
      </dl>
      ${foto}
    </article>`;
}

/* --------------------------------------------------------- pendientes --- */

/* Las filas que esperan una decisión se muestran acá TAMBIÉN, no sólo en la
 * bandeja: quien mira el lote tiene que ver que hay animales leídos que todavía
 * no cuentan. La revisión sigue siendo una sola, la de Gestión; esto es la
 * misma cola vista desde el lote. */
function maPendingSection(tracking) {
  const filas = tracking.pending_rows || [];
  const fotos = (tracking.indicators || {}).pending_images || 0;
  // Aunque no haya nada que decidir, puede haber material sin leer. Decir sólo
  // «no hay pendientes» ahí sería cierto y engañoso a la vez.
  const aviso = fotos
    ? `<p class="ma-pending__hint">${escapeHtml(
        `Además hay ${formatInteger(fotos)} foto(s) esperando lectura: todavía no se sabe qué traen.`,
      )}</p>`
    : "";
  if (!filas.length) {
    return `<p class="ma-ok">No hay registros esperando revisión.</p>${aviso}`;
  }
  const items = filas
    .map((fila) => {
      const meta = [
        fila.date ? formatDate(fila.date, { short: true }) : "Sin fecha",
        fila.ewe_identifier ? `madre ${fila.ewe_identifier}` : null,
        fila.has_photo ? "con foto de libreta" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <article class="ma-pending__item">
          <p class="ma-pending__code">${escapeHtml(fila.lamb_code ? `Cordero ${fila.lamb_code}` : "Cordero sin identificar")}</p>
          <p class="ma-pending__reason">${escapeHtml(fila.reason)}</p>
          <p class="ma-pending__meta">${escapeHtml(meta)}</p>
        </article>`;
    })
    .join("");
  return `
    <p class="ma-pending__count">${formatInteger(filas.length)} registro(s) esperando revisión. No suman a los acumulados hasta confirmarse.</p>
    <div class="ma-pending">${items}</div>
    <p class="ma-pending__hint">Se revisan en Gestión → Bandeja de revisión, con la foto a la vista.</p>
    ${aviso}`;
}

/* ------------------------------------------------- registro completo --- */

const MA_FILTERS = [
  ["TODOS", "Todos"],
  ["HOY", "Hoy"],
  ["MACHOS", "Machos"],
  ["HEMBRAS", "Hembras"],
  ["SIN_SEXO", "Sexo sin informar"],
];

function maFilteredRecords(tracking) {
  const texto = MA_STATE.busqueda.trim().toUpperCase();
  const hoy = tracking.today;
  const canonicoBuscado = texto.replace(/^0+/, "");
  return (tracking.records || []).filter((registro) => {
    if (MA_STATE.filtro === "HOY" && registro.date !== hoy) return false;
    if (MA_STATE.filtro === "MACHOS" && registro.sex !== "MACHO") return false;
    if (MA_STATE.filtro === "HEMBRAS" && registro.sex !== "HEMBRA") return false;
    if (MA_STATE.filtro === "SIN_SEXO" && registro.sex) return false;
    if (!texto) return true;
    // Se busca por cordero y por madre a la vez: quien tiene el número en la
    // mano no siempre sabe cuál de los dos está mirando. La comparación del
    // cordero usa la identidad canónica, así que «101» encuentra a «0101».
    const codigo = String(registro.code || "").toUpperCase();
    const canonico = String(registro.canonical_code || "").toUpperCase();
    const madre = String(registro.ewe_identifier || "").toUpperCase();
    return codigo.includes(texto) || canonico.includes(canonicoBuscado) || madre.includes(texto);
  });
}

function maRecordsSection(tracking) {
  const registros = maFilteredRecords(tracking);
  const total = (tracking.records || []).length;
  const pintados = registros.slice(0, MA_STATE.visibles);
  const filtros = MA_FILTERS.map(
    ([clave, texto]) =>
      `<button type="button" class="ma-chip${MA_STATE.filtro === clave ? " is-active" : ""}" data-ma-filter="${clave}" aria-pressed="${MA_STATE.filtro === clave}">${escapeHtml(texto)}</button>`,
  ).join("");
  const alcance =
    registros.length === total
      ? `${formatInteger(total)} cordero(s) identificado(s).`
      : `${formatInteger(registros.length)} de ${formatInteger(total)} cordero(s).`;
  const conteo =
    pintados.length < registros.length
      ? `${alcance} Se muestran ${formatInteger(pintados.length)}.`
      : alcance;
  return `
    <div class="ma-search">
      <label class="ma-search__label" for="ma-search-input">Buscar por Nº de cordero o de madre</label>
      <input id="ma-search-input" type="search" class="ma-search__input" placeholder="Ej.: 0101 o 128" value="${escapeHtml(MA_STATE.busqueda)}" autocomplete="off" />
    </div>
    <div class="ma-chips" role="group" aria-label="Filtros del registro">${filtros}</div>
    <p class="ma-records__count">${escapeHtml(conteo)}</p>
    ${
      registros.length
        ? `<div class="ma-records">${pintados.map(maRecordCard).join("")}</div>
           ${
             registros.length > pintados.length
               ? `<button type="button" class="ma-more" data-ma-more="1">Mostrar ${escapeHtml(
                   formatInteger(Math.min(MA_PAGINA, registros.length - pintados.length)),
                 )} más · quedan ${escapeHtml(
                   formatInteger(registros.length - pintados.length),
                 )}</button>`
               : ""
           }`
        : `<p class="empty-note">${escapeHtml(
            MA_STATE.busqueda.trim()
              ? "Ningún cordero coincide con la búsqueda."
              : "Ningún cordero cumple este filtro.",
          )}</p>`
    }`;
}

/* ------------------------------------------------------ consistencia --- */

/* Diferencias entre registros que alguien tiene que mirar. No se corrigen solas
 * ni se esconden: elegir cuál de los dos registros está mal es del responsable
 * del lote, no del tablero. */
function maConsistencySection(tracking) {
  const hallazgos = tracking.consistency || [];
  if (!hallazgos.length) return "";
  const items = hallazgos
    .map(
      (h) =>
        `<li><span class="ma-consistency__code">${escapeHtml(String(h.code).replace(/_/g, " "))}</span><span class="ma-consistency__detail">${escapeHtml(h.detail)}</span></li>`,
    )
    .join("");
  return `
    <section class="panel panel--warn">
      <div class="panel__head">
        <div>
          <p class="eyebrow">Control de consistencia</p>
          <h2>${escapeHtml(formatInteger(hallazgos.length))} punto(s) para revisar</h2>
        </div>
      </div>
      <ul class="ma-consistency">${items}</ul>
    </section>`;
}

/* ------------------------------------------------------------ página --- */

/* El orden es el de uso, no el de la base: primero cuánto va, después cómo
 * viene, después qué pasó cada día, qué falta revisar y por último el detalle
 * animal por animal. En un teléfono lo que está más abajo se lee menos, y lo
 * que menos se consulta es el listado completo. */
function maTrackingPanels(tracking) {
  return `
    <section class="panel panel--ma-head">
      <div class="panel__head">
        <div>
          <p class="eyebrow">Seguimiento de parición</p>
          <h2>Estado actual</h2>
        </div>
        <p>Registros individuales confirmados de la libreta de nacimientos.</p>
      </div>
      ${maIndicators(tracking)}
    </section>

    ${maConsistencySection(tracking)}

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Evolución</p><h2>Nacimientos por día y acumulado</h2></div>
        <p>Barras: lo del día. Línea: el acumulado de la campaña.</p>
      </div>
      <div id="ma-chart-body">${maChartSection(tracking)}</div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Detalle</p><h2>Parición día a día</h2></div>
        <p>Tocá una fecha para ver los corderos de ese día.</p>
      </div>
      <div id="ma-days">${maDaySection(tracking)}</div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Revisión</p><h2>Registros a revisar</h2></div>
      </div>
      ${maPendingSection(tracking)}
    </section>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Registro</p><h2>Registro de nacimientos</h2></div>
        <p>Un cordero por ficha, con su madre y su evidencia.</p>
      </div>
      <div id="ma-records-body">${maRecordsSection(tracking)}</div>
    </section>`;
}

/* Redibujado parcial: la búsqueda no puede rehacer la página entera o el campo
 * de texto pierde el foco en cada tecla. */
function renderMaRecords() {
  const tracking = maTracking();
  const body = byId("ma-records-body");
  if (!tracking || !body) return;
  const input = byId("ma-search-input");
  const posicion = input ? input.selectionStart : null;
  const activo = document.activeElement === input;
  body.innerHTML = maRecordsSection(tracking);
  if (!activo) return;
  const nuevo = byId("ma-search-input");
  if (!nuevo) return;
  nuevo.focus();
  if (posicion !== null) nuevo.setSelectionRange(posicion, posicion);
}

function renderMaDays() {
  const tracking = maTracking();
  const body = byId("ma-days");
  if (tracking && body) body.innerHTML = maDaySection(tracking);
}

function renderMaChart() {
  const tracking = maTracking();
  const body = byId("ma-chart-body");
  if (!tracking || !body) return;
  body.innerHTML = maChartSection(tracking);
  drawMaChart();
}

function onMaClick(event) {
  const serie = event.target.closest("[data-ma-serie]");
  if (serie) {
    MA_STATE.serie = serie.dataset.maSerie;
    renderMaChart();
    return;
  }
  const dia = event.target.closest("[data-ma-day]");
  if (dia) {
    const clave = dia.dataset.maDay;
    MA_STATE.dias[clave] = !MA_STATE.dias[clave];
    renderMaDays();
    return;
  }
  const filtro = event.target.closest("[data-ma-filter]");
  if (filtro) {
    MA_STATE.filtro = filtro.dataset.maFilter;
    MA_STATE.visibles = MA_PAGINA;
    renderMaRecords();
    return;
  }
  if (event.target.closest("[data-ma-more]")) {
    MA_STATE.visibles += MA_PAGINA;
    renderMaRecords();
  }
}

function onMaInput(event) {
  if (event.target && event.target.id === "ma-search-input") {
    MA_STATE.busqueda = event.target.value;
    MA_STATE.visibles = MA_PAGINA;
    renderMaRecords();
  }
}

function renderLot(lot) {
  const view = byId(`view-${lot.section}`);
  const module = moduleByCode(lot.code);
  if (!module) {
    view.innerHTML = `<header class="view__head"><h1 id="title-${lot.section}">${escapeHtml(lot.name)}</h1></header>
      <p class="empty-note">SIN DATO — este lote todavía no tiene base productiva importada.</p>`;
    return;
  }
  const curve = (DASH.lambing_curves?.lots || []).find((l) => l.code === lot.code) || null;
  const first = curve && curve.expected_original?.length ? curve.expected_original[0].date : null;
  const last = curve && curve.expected_original?.length
    ? curve.expected_original[curve.expected_original.length - 1].date
    : null;

  // Orden: primero la base del lote —de dónde sale todo lo demás—, después el
  // avance, después la mortalidad, y al final los anexos. Los indicadores
  // productivos van últimos: son la trazabilidad con numerador y denominador,
  // no la lectura operativa.
  view.innerHTML = `
    <header class="view__head lot-head">
      <div>
        <p class="eyebrow">MÓDULO</p>
        <h1 id="title-${lot.section}">${escapeHtml(lot.name)}</h1>
        ${lot.breed ? `<p class="lot-head__breed">${escapeHtml(lot.breed)}</p>` : ""}
      </div>
      <dl class="lot-head__meta">
        <div><dt>Estado de datos</dt><dd><span class="tag tag--${dataState(module) === "ACTUALIZADO" ? "ok" : "pending"}">${escapeHtml(dataState(module))}</span></dd></div>
        <div><dt>Parición prevista</dt><dd>${escapeHtml(first ? `${formatDate(first, { short: true })} → ${formatDate(last, { short: true })}` : "SIN CURVA")}</dd></div>
      </dl>
    </header>

    ${maTieneSeguimiento(lot.code) ? maTrackingPanels(maTracking()) : ""}

    <section class="panel panel--flat">
      <div class="panel__head">
        <div><p class="eyebrow">Base del lote</p><h2>Composición reproductiva</h2></div>
        <p>Carga fetal confirmada de la base productiva vigente.</p>
      </div>
      ${lotEcografia(module)}
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Ovejas paridas y corderos registrados</h2><p>${escapeHtml(DASH.overview.summary_label || "")}</p></div>
      <div class="stat-grid">${lotCounts(module)}</div>
      ${lotCountsNote(module)}
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Mortalidad</h2>${mortalityHint(module)}</div>
      ${lotMortality(lot, module)}
    </section>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Curva integral</p><h2>Curva prevista, evolución real y mortalidad</h2></div>
        <p>Comparación entre la distribución prevista de partos, los registros reales acumulados y diarios, y la mortalidad informada durante la campaña.</p>
      </div>
      ${curvePanel(lot.section, lot.code)}
    </section>

    <section class="panel">
      ${chillHead(lot.code)}
      ${chillPanel(lot.section, lot.code)}
    </section>

    ${servicesPanel(curve)}

    ${milestonesPanel(lot.code)}

    <section class="panel">
      <div class="panel__head"><h2>Indicadores productivos</h2><p>Generados por el sistema con numerador y denominador explícitos.</p></div>
      ${indicatorTable(((DASH.productive_indicators || {}).by_module || {})[lot.code], `Indicadores de ${lot.name}`)}
    </section>`;
}

// Composición ecográfica del lote (cifras de la base productiva, sin modificar).
function lotEcografia(module) {
  const iv = module.initial_values;
  const val = (v) => (v === null || v === undefined ? "NO INFORMADO" : formatInteger(v));
  const items = [
    ["Servidas", iv.served],
    ["Ecografiadas", iv.scanned],
    ["Vacías", iv.empty],
    ["Únicas", iv.single],
    ["Dobles", iv.double],
    ["Triples", iv.triple],
    ["Preñadas", iv.expected_to_lamb],
    ["Corderos esp.", iv.expected_lambs],
  ];
  return `
    <div class="stat-grid">${items.map(([label, v]) => metricCard(label, val(v))).join("")}</div>
    <p class="chart-note">Preñadas = únicas + dobles + triples · Corderos esperados = únicas + 2×dobles + 3×triples.</p>`;
}

/* Las cuatro cifras que sólo viven acá. Todo lo demás que había en este panel
 * —la base del lote, los porcentajes, la mortalidad, los nacidos muertos— ya
 * estaba en su propio panel: repetirlo no agregaba información y hacía que
 * ninguna posición fuera la autoritativa.
 *
 * El orden es la cadena de reconstrucción, y hay que poder leerla seguida:
 *
 *     corderos vivos contabilizados + corderos muertos acumulados
 *       = corderos nacidos acumulados
 *
 * El recuento de vivos es una fotografía de su fecha: no se actualiza restando
 * las muertes cargadas después, sólo lo reemplaza un recuento nuevo.
 */
function lotCounts(module) {
  const ec = module.ewe_counts;
  const lc = module.lamb_counts;
  const mort = module.mortality;

  // --- ovejas paridas -----------------------------------------------------
  const paridas =
    ec.counted_lambed === null || ec.counted_lambed === undefined
      ? "SIN RECUENTO"
      : `${formatInteger(ec.counted_lambed)} de ${formatInteger(ec.expected_to_lamb)}`;
  const paridasNota = notaDeAvance(
    ec.progress,
    ec.remaining,
    "por parir",
    "Ovejas paridas sobre ovejas previstas a parir.",
  );

  // --- recuento físico de corderos vivos ----------------------------------
  const stock =
    lc.current_stock_lambs === null || lc.current_stock_lambs === undefined
      ? "SIN RECUENTO"
      : formatInteger(lc.current_stock_lambs);
  // La fecha va en la tarjeta, no sólo al pie: es lo que convierte el número en
  // una fotografía fechada en vez de un stock vivo continuo.
  const stockNota = lc.current_stock_count_date
    ? `Recuento del ${formatDayMonthYear(lc.current_stock_count_date)}`
    : null;

  // --- muertes acumuladas de cordero --------------------------------------
  // `mortality.lamb_deaths_accumulated` es `null` cuando el lote no tiene
  // registros; `lamb_counts.accumulated_lamb_deaths` vale 0 en ese mismo caso.
  // Son campos distintos: acá se usa el primero para no mostrar «0 muertes»
  // donde lo que pasa es que nadie informó nada todavía.
  const muertos =
    mort.lamb_deaths_accumulated === null || mort.lamb_deaths_accumulated === undefined
      ? "SIN REGISTROS"
      : formatInteger(mort.lamb_deaths_accumulated);

  // --- reconstrucción de nacidos ------------------------------------------
  const nacidos =
    lc.estimated_born_lambs === null || lc.estimated_born_lambs === undefined
      ? "SIN CÁLCULO"
      : `${formatInteger(lc.estimated_born_lambs)} de ${formatInteger(lc.expected_total)}`;
  const nacidosNota = notaDeNacidos(lc);

  return [
    metricCard("Ovejas paridas registradas", paridas, paridasNota),
    metricCard(lc.current_stock_label || "Corderos vivos contabilizados", stock, stockNota),
    metricCard("Corderos muertos acumulados", muertos),
    metricCard("Corderos nacidos acumulados", nacidos, nacidosNota),
  ].join("");
}

/* Porcentaje y restantes como NOTA, no como tarjetas propias: son la misma
 * cifra dicha de otra forma. Los dos vienen validados por el backend —el
 * frontend no resta ni calcula porcentajes— y un restante nunca se muestra si
 * el backend no lo dio por bueno. */
function notaDeAvance(progress, remaining, sufijo, respaldo) {
  const partes = [];
  if (progress && progress.percent !== null && progress.percent !== undefined) {
    partes.push(formatPercent(progress.percent));
  }
  if (remaining && remaining.value !== null && remaining.value !== undefined) {
    partes.push(`faltan ${formatInteger(remaining.value)} ${sufijo}`);
  }
  return partes.length ? partes.join(" · ") : respaldo;
}

/* La nota hace visible la cadena que produjo el número:
 *
 *     último recuento físico de vivos + TODAS las muertes de la campaña
 *
 * No es una estimación ni una conjetura: el recuento es un dato de campo y las
 * muertes son eventos registrados. Es el acumulado operativo con los datos
 * disponibles. */
function notaDeNacidos(lc) {
  if (lc.estimated_born_lambs === null || lc.estimated_born_lambs === undefined) {
    return lc.estimated_born_basis || null;
  }
  const partes = [];
  if (lc.current_stock_lambs !== null && lc.current_stock_lambs !== undefined) {
    partes.push(
      `${formatInteger(lc.current_stock_lambs)} vivos + ` +
        `${formatInteger(lc.accumulated_lamb_deaths)} muertos`,
    );
  }
  const avance = lc.lamb_progress_ratio;
  if (avance && avance.value !== null && avance.value !== undefined) {
    partes.push(formatPercent(avance.value));
  }
  const restantes = lc.remaining_estimated;
  if (restantes && restantes.value !== null && restantes.value !== undefined) {
    partes.push(`faltarían ${formatInteger(restantes.value)}`);
  }
  return partes.length ? partes.join(" · ") : null;
}

function lotCountsNote(module) {
  const lc = module.lamb_counts;
  if (lc.estimated_born_lambs === null || lc.estimated_born_lambs === undefined) return "";
  const fecha = lc.current_stock_count_date ? formatDate(lc.current_stock_count_date) : "—";
  return `<p class="chart-note">${escapeHtml(
    `Corderos vivos contabilizados el ${fecha}: ${formatInteger(lc.current_stock_lambs)}. ` +
      `Ese valor corresponde al último recuento físico y se mantiene hasta que ` +
      `se realice un nuevo recuento. ` +
      `Sumándole los ${formatInteger(lc.accumulated_lamb_deaths)} corderos muertos ` +
      `acumulados de la campaña, se registran ` +
      `${formatInteger(lc.estimated_born_lambs)} corderos nacidos acumulados.`,
  )}</p>`;
}

/* ---------------------------------------------------------- servicios --- */

function servicesPanel(curve) {
  const services = (curve && curve.services) || [];
  if (!services.length) {
    return `
    <section class="panel panel--flat">
      <div class="panel__head"><h2>Servicios del lote</h2></div>
      <p class="empty-note">SIN SERVICIOS declarados en la fuente para este lote.</p>
    </section>`;
  }
  const rows = services
    .map(
      (service) => `
      <tr>
        <td>${escapeHtml(service.service_type)}</td>
        <td>${escapeHtml(formatDate(service.start_date))}</td>
        <td>${escapeHtml(formatDate(service.end_date))}</td>
        <td class="num">${escapeHtml(service.ewes === null || service.ewes === undefined ? "NO INFORMADO" : formatInteger(Math.round(service.ewes)))}</td>
        <td>${escapeHtml(
          service.lambing_window_start
            ? `${formatDate(service.lambing_window_start, { short: true })} → ${formatDate(service.lambing_window_end, { short: true })}`
            : "SIN CURVA",
        )}</td>
        <td class="num">${escapeHtml(formatInteger(service.expected_to_lamb))}</td>
        <td class="num">${escapeHtml(formatInteger(service.expected_lambs))}</td>
      </tr>`,
    )
    .join("");
  const limitation = services.find((service) => service.curve_is_aggregated);
  return `
    <section class="panel panel--flat">
      <div class="panel__head"><h2>Servicios del lote</h2><p>Tipo, fechas y previstos según la fuente.</p></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Tipo de servicio</th><th>Desde</th><th>Hasta</th><th class="num">Ovejas</th><th>Período probable de partos</th><th class="num">Ovejas previstas</th><th class="num">Corderos previstos</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${limitation ? `<p class="chart-note">${escapeHtml(limitation.limitation)} No se reparten animales entre servicios de forma artificial.</p>` : ""}
    </section>`;
}

/* ---------------------------------------------- curva integral (§7–§10) --- */

const CURVE_COLORS = {
  original: "#7fb69a",
  adjusted: "#006937",
  observed: "#1b6ec2",
  checkpoint: "#0f4c81",
  lambDeath: "#c0402f",
  eweDeath: "#111111",
};

function defaultChartState(lotCode) {
  return {
    lot: lotCode || "TOTAL",
    mode: "cumulative",
    series: { original: true, adjusted: true, observed: true },
    mortality: { lamb: true, ewe: true },
    from: "",
    to: "",
    selected: null,
  };
}

function chartState(viewKey, lotCode) {
  if (!CHART_STATE[viewKey]) CHART_STATE[viewKey] = defaultChartState(lotCode);
  return CHART_STATE[viewKey];
}

/* Qué series tiene REALMENTE el lote, para no ofrecer interruptores vacíos.
 *
 * Un lote que todavía no parió mostraba los cinco controles con los cinco
 * marcados, y cuatro no encendían nada: la curva ajustada nace de un recuento
 * de campo, la evolución real de partos registrados y las dos mortalidades de
 * eventos informados. Prometían una serie que no existe.
 *
 * La disponibilidad se pregunta a `chartData` —la misma fuente que dibuja— pero
 * SIN el filtro de fechas: los controles dependen del lote, no del rango que el
 * usuario esté mirando. Si dependieran del rango, acotar las fechas haría
 * desaparecer el interruptor y ya no habría forma de volver a encender la
 * serie. Y al reutilizar `chartData` no se duplica ninguna regla: los puntos de
 * control acumulados cuentan como «observada» porque es ese interruptor el que
 * los dibuja.
 *
 * No hay ningún código de lote acá: cuando aparezcan los datos, aparece el
 * control solo. */
function seriesDisponibles(state) {
  const data = chartData({ ...state, from: "", to: "" });
  const hayMuertes = (animal) => data.mortality.some((row) => row.animal_type === animal);
  return {
    adjusted: data.adjusted.size > 0,
    observed: data.observed.size > 0 || data.checkpoints.length > 0,
    lamb: hayMuertes("CORDERO"),
    ewe: hayMuertes("OVEJA"),
  };
}

function curvePanel(viewKey, lotCode) {
  const curves = DASH.lambing_curves || {};
  if (!Array.isArray(curves.lots) || !curves.lots.length) {
    return `<p class="empty-note">SIN CURVA CARGADA — el gráfico se habilita cuando exista curva de partos.</p>`;
  }
  const state = chartState(viewKey, lotCode);
  const hay = seriesDisponibles(state);
  const lotOptions = lotCode
    ? ""
    : `
      <label class="filter">
        <span>Lote</span>
        <select data-chart="${escapeHtml(viewKey)}" data-filter="lot">
          <option value="TOTAL">Total campaña</option>
          ${LOTS.map(
            (lot) =>
              `<option value="${lot.code}" ${state.lot === lot.code ? "selected" : ""}>${escapeHtml(lot.name)}</option>`,
          ).join("")}
        </select>
      </label>`;
  return `
    <div class="chart-filters">
      ${lotOptions}
      <label class="filter">
        <span>Vista</span>
        <select data-chart="${escapeHtml(viewKey)}" data-filter="mode">
          <option value="cumulative" ${state.mode === "cumulative" ? "selected" : ""}>Acumulada</option>
          <option value="daily" ${state.mode === "daily" ? "selected" : ""}>Diaria</option>
        </select>
      </label>
      <label class="filter">
        <span>Desde</span>
        <input type="date" data-chart="${escapeHtml(viewKey)}" data-filter="from" value="${escapeHtml(state.from)}" />
      </label>
      <label class="filter">
        <span>Hasta</span>
        <input type="date" data-chart="${escapeHtml(viewKey)}" data-filter="to" value="${escapeHtml(state.to)}" />
      </label>
    </div>
    <div class="chart-toggles" role="group" aria-label="Series visibles">
      ${toggle(viewKey, "series", "original", "Curva prevista original", state.series.original, CURVE_COLORS.original)}
      ${hay.adjusted ? toggle(viewKey, "series", "adjusted", "Curva prevista ajustada", state.series.adjusted, CURVE_COLORS.adjusted) : ""}
      ${hay.observed ? toggle(viewKey, "series", "observed", "Evolución real observada", state.series.observed, CURVE_COLORS.observed) : ""}
      ${hay.lamb ? toggle(viewKey, "mortality", "lamb", "Mortalidad de corderos", state.mortality.lamb, CURVE_COLORS.lambDeath) : ""}
      ${hay.ewe ? toggle(viewKey, "mortality", "ewe", "Mortalidad de ovejas", state.mortality.ewe, CURVE_COLORS.eweDeath) : ""}
    </div>
    <div class="chart-wrap chart-wrap--integral">
      <canvas id="curve-${escapeHtml(viewKey)}" role="img" aria-label="Curva prevista, evolución real y mortalidad"></canvas>
      <div class="chart-tip" id="tip-${escapeHtml(viewKey)}" hidden></div>
    </div>
    <p class="chart-note" id="curve-note-${escapeHtml(viewKey)}"></p>
    <div class="day-detail" id="day-${escapeHtml(viewKey)}"></div>`;
}

function toggle(viewKey, group, key, label, checked, colour) {
  return `
    <label class="toggle">
      <input type="checkbox" data-chart="${escapeHtml(viewKey)}" data-group="${group}" data-key="${key}" ${checked ? "checked" : ""} />
      <i style="background:${colour}"></i>
      <span>${escapeHtml(label)}</span>
    </label>`;
}

// Datos del gráfico para el lote/estado actual. Cada serie conserva su origen:
// la agregación "Total" suma para visualizar, sin perder la identidad del lote.
function chartData(state) {
  const curves = DASH.lambing_curves || {};
  const lots = (curves.lots || []).filter((lot) => state.lot === "TOTAL" || lot.code === state.lot);
  // `TOTAL` no es un lote del contrato: es el ámbito agregado de la campaña.
  // Distinguirlo no es un candado por nombre de lote — los tres lotes reales se
  // tratan igual entre sí— y ya gobierna el acumulado consolidado más abajo.
  const esAmbitoAgregado = state.lot === "TOTAL";
  const inRange = (date) =>
    (!state.from || date >= state.from) && (!state.to || date <= state.to);

  const original = new Map();
  const adjusted = new Map();
  const observed = new Map();
  const checkpoints = [];
  for (const lot of lots) {
    for (const point of lot.expected_original || []) {
      if (!inRange(point.date)) continue;
      const bucket = original.get(point.date) || { ewes: 0, lambs: 0, cumulative: null };
      bucket.ewes += Number(point.expected_ewes) || 0;
      bucket.lambs += Number(point.expected_lambs) || 0;
      if (state.lot !== "TOTAL") bucket.cumulative = point.cumulative_pct;
      original.set(point.date, bucket);
    }
    for (const point of lot.expected_adjusted || []) {
      if (!inRange(point.date)) continue;
      const bucket = adjusted.get(point.date) || { ewes: 0, lambs: 0, cumulative: null };
      bucket.ewes += Number(point.expected_ewes) || 0;
      bucket.lambs += Number(point.expected_lambs) || 0;
      if (state.lot !== "TOTAL") bucket.cumulative = point.cumulative_pct;
      adjusted.set(point.date, bucket);
    }
    for (const point of lot.observed_series || []) {
      if (!inRange(point.date)) continue;
      const bucket = observed.get(point.date) || { ewes: 0, lambs: 0, cumulative: null };
      bucket.ewes += Number(point.lambed_ewes) || 0;
      bucket.lambs += Number(point.born_lambs) || 0;
      if (state.lot !== "TOTAL") bucket.cumulative = point.cumulative_pct;
      observed.set(point.date, bucket);
    }
    // Un punto de control acumulado se dibuja para CUALQUIER lote que lo traiga
    // en el contrato. Antes había un candado por nombre —`state.lot ===
    // "INTENSIVO"`— que era el único lote con recuento cuando se escribió: si
    // Merino Dohne o Merino Australiano informaban uno, el punto quedaba
    // invisible sin que nada lo avisara. Lo decide el DATO, no el lote.
    //
    // Lo que sí decide el ÁMBITO. Un control pertenece al lote que lo informó:
    // su población y su denominador son los de ese lote. «Total campaña» no
    // puede heredarlo —44 / 96 es el avance de ovejas de Intensivo, no el de la
    // campaña— ni inferirlo sumando controles parciales, que medirían cada uno
    // contra una base distinta. Hasta que el contrato publique un control de
    // campaña con su propia población, el ámbito agregado no dibuja ninguno.
    //
    // Esto NO reintroduce el candado derogado: no hay ningún código de lote en
    // la condición. `TOTAL` no es un lote, es el ámbito agregado —el mismo que
    // ya decide el acumulado consolidado unas líneas más abajo—, y cualquier
    // lote real, presente o futuro, sigue dibujando el suyo.
    if (!esAmbitoAgregado) {
      for (const point of lot.observed_checkpoints || []) {
        // Sin fecha no hay dónde ubicarlo: no se inventa una columna.
        if (!point.date || !inRange(point.date)) continue;
        checkpoints.push({ ...point, module_code: lot.code });
      }
    }
  }
  // Acumulado del total: viene consolidado del backend (no se suman %).
  if (state.lot === "TOTAL") {
    for (const point of curves.consolidated || []) {
      const bucket = original.get(point.date);
      if (bucket) bucket.cumulative = point.cumulative_pct;
    }
  }

  const mortality = (DASH.mortality_daily || []).filter(
    (row) => (state.lot === "TOTAL" || row.module_code === state.lot) && inRange(row.date),
  );
  const dates = new Set([...original.keys(), ...adjusted.keys(), ...observed.keys()]);
  mortality.forEach((row) => dates.add(row.date));
  checkpoints.forEach((point) => dates.add(point.date));
  return {
    dates: [...dates].sort(),
    original,
    adjusted,
    observed,
    checkpoints,
    mortality,
    adjustedLots: (curves.adjusted_lots || []).filter(
      (code) => state.lot === "TOTAL" || code === state.lot,
    ),
  };
}

function mortalityAt(data, date, kind) {
  const animal = kind === "lamb" ? "CORDERO" : "OVEJA";
  return data.mortality
    .filter((row) => row.date === date && row.animal_type === animal)
    .reduce((total, row) => total + (Number(row.quantity) || 0), 0);
}

function drawIntegralChart(viewKey, lotCode) {
  const state = chartState(viewKey, lotCode);
  const canvas = byId(`curve-${viewKey}`);
  if (!canvas) return;
  const data = chartData(state);
  const note = byId(`curve-note-${viewKey}`);
  if (note) note.innerHTML = curveNote(state, data);
  const wrap = canvas.parentElement;
  if (!wrap || !data.dates.length) return;

  const context = canvas.getContext("2d");
  // El ancho útil descuenta el relleno del contenedor: si no, el lienzo
  // desborda su caja y aparece una barra horizontal en móvil.
  const style = window.getComputedStyle(wrap);
  const inset = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
  const width = Math.max(240, Math.floor(wrap.clientWidth - inset));
  const height = 360;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { top: 20, right: 46, bottom: 40, left: 48 };
  // Banda inferior independiente para la mortalidad: con su propia escala, no
  // deforma las curvas de ovejas y corderos.
  const bandHeight = 62;
  const gap = 16;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom - bandHeight - gap;
  const bandTop = padding.top + plotHeight + gap;
  const slot = plotWidth / data.dates.length;
  const centreOf = (index) => padding.left + slot * index + slot / 2;
  const columnByDate = new Map(data.dates.map((date, index) => [date, index]));

  const cumulative = state.mode === "cumulative";
  const maxDaily = Math.max(
    ...data.dates.map((date) => {
      const orig = data.original.get(date) || { ewes: 0, lambs: 0 };
      const adj = data.adjusted.get(date) || { ewes: 0, lambs: 0 };
      const obs = data.observed.get(date) || { ewes: 0, lambs: 0 };
      return Math.max(
        state.series.original ? Math.max(orig.ewes, orig.lambs) : 0,
        state.series.adjusted ? Math.max(adj.ewes, adj.lambs) : 0,
        state.series.observed ? Math.max(obs.ewes, obs.lambs) : 0,
      );
    }),
    1,
  );

  context.strokeStyle = "rgba(135, 135, 134, 0.28)";
  context.lineWidth = 1;
  context.font = "11px Inter, system-ui, sans-serif";
  context.fillStyle = "#878786";
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (plotHeight / 4) * step;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
    context.textAlign = "right";
    const label = cumulative
      ? `${Math.round(((4 - step) / 4) * 100)}%`
      : integerFormatter.format(Math.round((maxDaily * (4 - step)) / 4));
    context.fillText(label, padding.left - 6, y + 4);
  }

  if (cumulative) {
    const line = (map, colour, dashed) => {
      const points = data.dates
        .map((date) => ({ date, value: (map.get(date) || {}).cumulative }))
        .filter(
          (point) =>
            point.value !== null &&
            point.value !== undefined &&
            Number.isFinite(Number(point.value)),
        );
      if (!points.length) return;
      context.beginPath();
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.setLineDash(dashed ? [6, 4] : []);
      points.forEach((point, order) => {
        const x = centreOf(columnByDate.get(point.date));
        const y = padding.top + plotHeight - Math.min(Number(point.value), 1) * plotHeight;
        if (order === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      context.setLineDash([]);
    };
    if (state.series.original) line(data.original, CURVE_COLORS.original, true);
    if (state.series.adjusted) line(data.adjusted, CURVE_COLORS.adjusted, false);
    if (state.series.observed) line(data.observed, CURVE_COLORS.observed, false);
  } else {
    const barWidth = Math.max(1.5, Math.min(9, slot * 0.3));
    data.dates.forEach((date, index) => {
      const centre = centreOf(index);
      const draw = (value, colour, offset) => {
        const barHeight = (value / maxDaily) * plotHeight;
        if (barHeight <= 0) return;
        context.fillStyle = colour;
        context.fillRect(centre + offset, padding.top + plotHeight - barHeight, barWidth, barHeight);
      };
      const orig = data.original.get(date) || { ewes: 0, lambs: 0 };
      const adj = data.adjusted.get(date) || { ewes: 0, lambs: 0 };
      const obs = data.observed.get(date) || { ewes: 0, lambs: 0 };
      if (state.series.original) {
        draw(orig.ewes, "rgba(127, 182, 154, 0.85)", -barWidth * 1.6);
        draw(orig.lambs, "rgba(127, 182, 154, 0.42)", -barWidth * 0.5);
      }
      if (state.series.adjusted) draw(adj.ewes, CURVE_COLORS.adjusted, barWidth * 0.6);
      if (state.series.observed) draw(obs.ewes, CURVE_COLORS.observed, barWidth * 1.7);
    });
  }

  // Punto de control acumulado: marca aislada y etiquetada. NUNCA se une con
  // una línea como si todos los animales hubieran nacido ese día.
  if (state.series.observed) {
    for (const point of data.checkpoints) {
      const index = columnByDate.get(point.date);
      if (index === undefined) continue;
      const x = centreOf(index);
      // El backend calcula este cociente con el denominador del propio módulo;
      // no se reconstruye contra el total de campaña.
      const pct = Number(point.cumulative_ewes_pct);
      const y = cumulative && Number.isFinite(pct)
        ? padding.top + plotHeight - Math.min(Math.max(pct, 0), 1) * plotHeight
        : padding.top + 10;
      context.save();
      context.strokeStyle = CURVE_COLORS.checkpoint;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, padding.top);
      context.lineTo(x, padding.top + plotHeight);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = CURVE_COLORS.checkpoint;
      context.beginPath();
      context.moveTo(x, y - 6);
      context.lineTo(x + 6, y);
      context.lineTo(x, y + 6);
      context.lineTo(x - 6, y);
      context.closePath();
      context.fill();
      context.restore();
    }
  }

  // Banda de mortalidad diaria, escala propia.
  const maxDeaths = Math.max(
    ...data.dates.map((date) =>
      Math.max(
        state.mortality.lamb ? mortalityAt(data, date, "lamb") : 0,
        state.mortality.ewe ? mortalityAt(data, date, "ewe") : 0,
      ),
    ),
    1,
  );
  context.strokeStyle = "rgba(135, 135, 134, 0.35)";
  context.beginPath();
  context.moveTo(padding.left, bandTop + bandHeight);
  context.lineTo(padding.left + plotWidth, bandTop + bandHeight);
  context.stroke();
  context.fillStyle = "#878786";
  context.textAlign = "right";
  context.fillText(integerFormatter.format(maxDeaths), padding.left - 6, bandTop + 10);
  const deathBar = Math.max(1.5, Math.min(7, slot * 0.24));
  data.dates.forEach((date, index) => {
    const centre = centreOf(index);
    const kinds = [
      ["lamb", CURVE_COLORS.lambDeath, -deathBar * 1.6],
      ["ewe", CURVE_COLORS.eweDeath, -deathBar * 0.3],
    ];
    for (const [kind, colour, offset] of kinds) {
      if (!state.mortality[kind]) continue;
      const value = mortalityAt(data, date, kind);
      if (!value) continue;
      const barHeight = (value / maxDeaths) * (bandHeight - 8);
      const barX = centre + offset;
      const barY = bandTop + bandHeight - barHeight;
      context.fillStyle = colour;
      context.fillRect(barX, barY, deathBar, barHeight);
      // La oveja conserva la barra, con un marcador superior que también la
      // distingue del cordero cuando el ancho disponible es mínimo.
      if (kind === "ewe") {
        context.beginPath();
        context.arc(barX + deathBar / 2, barY, Math.max(2.5, deathBar * 0.55), 0, Math.PI * 2);
        context.fill();
      }
    }
  });

  context.fillStyle = "#878786";
  context.textAlign = "center";
  const labelEvery = Math.max(1, Math.ceil(data.dates.length / 8));
  data.dates.forEach((date, index) => {
    if (index % labelEvery !== 0 && index !== data.dates.length - 1) return;
    context.fillText(formatDate(date, { short: true, includeYear: false }), centreOf(index), height - 12);
  });

  attachChartPointer(viewKey, canvas, data, { padding, plotWidth, slot });
  renderDayDetail(viewKey, state, data);
}

function curveNote(state, data) {
  const notes = [];
  // La nota describe lo que se ve. Sin mortalidad no hay barras inferiores que
  // explicar, así que esa frase se omite en vez de anunciar un elemento
  // ausente. No se la reemplaza por un «sin datos»: lo que no está, no se
  // nombra.
  const barras = data.mortality.length ? " Barras inferiores: mortalidad diaria informada." : "";
  if (state.mode === "cumulative") {
    notes.push(`Líneas: avance acumulado de cada serie.${barras}`);
  } else {
    notes.push(`Barras: valores diarios de cada serie.${barras}`);
  }
  for (const point of data.checkpoints) {
    notes.push(
      `Último recuento acumulado al ${formatDayMonth(point.date)} en ${LOT_FULL_NAME[point.module_code] || point.module_code}: ` +
        `${formatInteger(point.lambed_ewes)} ovejas paridas y ${formatInteger(point.confirmed_live_lambs ?? point.registered_born_lambs)} corderos vivos contabilizados. ` +
        `Sin distribución diaria informada.`,
    );
  }
  if (state.lot === "TOTAL" && data.adjustedLots.length && data.adjustedLots.length < LOTS.length) {
    notes.push(
      `La curva ajustada existe sólo en ${lotNames(data.adjustedLots)}: se consulta en la vista de ese lote para no mezclar lotes.`,
    );
  }
  return notes.filter(Boolean).map((text) => escapeHtml(text)).join("<br />");
}

function attachChartPointer(viewKey, canvas, data, geometry) {
  const tip = byId(`tip-${viewKey}`);
  const indexAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - geometry.padding.left;
    if (x < 0 || x > geometry.plotWidth) return null;
    const index = Math.floor(x / geometry.slot);
    return index >= 0 && index < data.dates.length ? index : null;
  };
  canvas.onpointermove = (event) => {
    const index = indexAt(event);
    if (index === null || !tip) {
      if (tip) tip.hidden = true;
      return;
    }
    tip.innerHTML = tooltipHtml(data, data.dates[index]);
    tip.hidden = false;
    const rect = canvas.getBoundingClientRect();
    const left = Math.min(Math.max(event.clientX - rect.left - 90, 4), rect.width - 200);
    tip.style.left = `${Math.max(4, left)}px`;
  };
  canvas.onpointerleave = () => {
    if (tip) tip.hidden = true;
  };
  canvas.onclick = (event) => {
    const index = indexAt(event);
    if (index === null) return;
    const state = CHART_STATE[viewKey];
    state.selected = data.dates[index];
    renderDayDetail(viewKey, state, data);
    const detail = byId(`day-${viewKey}`);
    if (detail) detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
}

function roundedExpectedAnimalText(value, singular, plural) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  const rounded = Math.round(numeric);
  return `${formatInteger(rounded)} ${rounded === 1 ? singular : plural}`;
}

function animalCountText(value, singular, plural) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return "";
  return `${formatInteger(numeric)} ${numeric === 1 ? singular : plural}`;
}

function meaningfulTooltipDetail(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text || isAbsenceState(text)) return "";
  const normalized = text.toLocaleLowerCase("es").replace(/\s+/g, " ");
  if (/^(causa|momento) no determinad[oa]$/.test(normalized)) return "";
  if (/^no (informad[oa]|determinad[oa])$/.test(normalized)) return "";
  return text;
}

function groupedTooltipMortality(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    if (row.animal_type !== "OVEJA" && row.animal_type !== "CORDERO") continue;
    const moduleName = LOT_FULL_NAME[row.module_code] || String(row.module_code || "").trim();
    if (!moduleName) continue;
    const cause = meaningfulTooltipDetail(row.cause_label);
    const moment = meaningfulTooltipDetail(row.death_moment_label);
    const key = JSON.stringify([row.animal_type, moduleName, cause, moment]);
    const item = grouped.get(key) || {
      animalType: row.animal_type,
      moduleName,
      cause,
      moment,
      quantity: 0,
    };
    item.quantity += quantity;
    grouped.set(key, item);
  }
  return [...grouped.values()];
}

function tooltipMortalityLine(item) {
  const isEwe = item.animalType === "OVEJA";
  const count = animalCountText(item.quantity, isEwe ? "oveja" : "cordero", isEwe ? "ovejas" : "corderos");
  if (!count) return "";
  const mortalityColour = isEwe ? CURVE_COLORS.eweDeath : CURVE_COLORS.lambDeath;
  const details = [];
  if (item.cause && item.moment) {
    details.push(`Causa: ${escapeHtml(item.cause)}`, `Momento: ${escapeHtml(item.moment)}`);
  } else if (item.cause) {
    details.push(escapeHtml(item.cause));
  } else if (item.moment) {
    details.push(escapeHtml(item.moment));
  }
  const suffix = details.length ? ` · ${details.join(" · ")}` : "";
  return `<span aria-hidden="true" style="color:${mortalityColour}">●</span> ${escapeHtml(count)} · ${escapeHtml(item.moduleName)}${suffix}`;
}

function tooltipHtml(data, date) {
  const rows = [`<strong>${escapeHtml(formatDate(date))}</strong>`];
  const orig = data.original.get(date);
  if (orig) {
    const expected = [
      roundedExpectedAnimalText(orig.ewes, "oveja", "ovejas"),
      roundedExpectedAnimalText(orig.lambs, "cordero", "corderos"),
    ].filter(Boolean);
    if (expected.length) rows.push(`Previsto: ${expected.map((value) => escapeHtml(value)).join(" · ")}`);
  }
  const obs = data.observed.get(date);
  if (obs) {
    rows.push(`Observado: ${escapeHtml(formatInteger(obs.ewes))} ovejas · ${escapeHtml(formatInteger(obs.lambs))} corderos`);
  }
  for (const point of data.checkpoints.filter((item) => item.date === date)) {
    rows.push("Recuento acumulado informado en esta fecha");
    rows.push(`Lote: ${escapeHtml(LOT_FULL_NAME[point.module_code] || point.module_code)}`);
  }
  const mortality = groupedTooltipMortality(data.mortality.filter((item) => item.date === date));
  for (const item of mortality) {
    const line = tooltipMortalityLine(item);
    if (line) rows.push(line);
  }
  const risk = (DASH.chill_public?.daily || []).find((day) => day.date === date);
  if (risk) rows.push(`Riesgo climático previsto: ${escapeHtml(riskLabel(risk.risk_category))}`);
  return rows.join("<br />");
}

/* Detalle diario estructurado (§10). */
function renderDayDetail(viewKey, state, data) {
  const host = byId(`day-${viewKey}`);
  if (!host) return;
  const date = state.selected;
  if (!date) {
    host.innerHTML = `<p class="chart-note">Tocá una fecha del gráfico para ver su detalle.</p>`;
    return;
  }
  const orig = data.original.get(date);
  const adj = data.adjusted.get(date);
  const obs = data.observed.get(date);
  const checkpoints = data.checkpoints.filter((item) => item.date === date);
  const deaths = data.mortality.filter((item) => item.date === date);
  const risk = (DASH.chill_public?.daily || []).find((day) => day.date === date);
  const milestones = (DASH.campaign_milestones?.items || []).filter(
    (item) => item.date === date && (state.lot === "TOTAL" || item.module_code === state.lot),
  );

  const cell = (label, value) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${absentClass(value)}">${escapeHtml(value)}</dd></div>`;
  const lambDeaths = deaths
    .filter((row) => row.animal_type === "CORDERO")
    .reduce((total, row) => total + row.quantity, 0);
  const eweDeaths = deaths
    .filter((row) => row.animal_type === "OVEJA")
    .reduce((total, row) => total + row.quantity, 0);

  host.innerHTML = `
    <h3 class="day-detail__title">Detalle del ${escapeHtml(formatDate(date))}</h3>
    <dl class="control-grid">
      ${cell("Lote", state.lot === "TOTAL" ? "Total campaña" : LOT_FULL_NAME[state.lot] || state.lot)}
      ${cell("Ovejas previstas", orig ? formatDecimal(orig.ewes) : "SIN CURVA")}
      ${cell("Corderos previstos", orig ? formatDecimal(orig.lambs) : "SIN CURVA")}
      ${cell("Ovejas previstas (ajustada)", adj ? formatDecimal(adj.ewes) : "SIN AJUSTE")}
      ${cell("Ovejas paridas registradas ese día", obs ? formatInteger(obs.ewes) : "SIN REGISTROS")}
      ${cell("Corderos nacidos registrados ese día", obs ? formatInteger(obs.lambs) : "SIN REGISTROS")}
      ${cell("Corderos muertos posteriormente", deaths.length ? formatInteger(lambDeaths) : "SIN REGISTROS")}
      ${cell("Ovejas muertas", deaths.length ? formatInteger(eweDeaths) : "SIN REGISTROS")}
      ${cell("Riesgo climático previsto", risk ? riskLabel(risk.risk_category) : "SIN DATO")}
    </dl>
    ${checkpoints
      .map(
        (point) => `
      <p class="day-detail__checkpoint"><span class="tag tag--muted">ACUMULADO</span>
      Recuento acumulado informado en esta fecha:
      ${escapeHtml(formatInteger(point.lambed_ewes))} ovejas paridas y
      ${escapeHtml(formatInteger(point.confirmed_live_lambs ?? point.registered_born_lambs))} corderos vivos contabilizados.
      No es un valor diario.</p>`,
      )
      .join("")}
    ${
      deaths.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Animal</th><th class="num">Cant.</th><th>Causa</th><th>Momento</th></tr></thead><tbody>${deaths
            .map(
              (row) => `<tr>
              <td>${escapeHtml(row.animal_type === "OVEJA" ? "Oveja" : "Cordero")}</td>
              <td class="num">${escapeHtml(formatInteger(row.quantity))}</td>
              <td>${escapeHtml(row.cause_label)}</td>
              <td>${escapeHtml(row.death_moment_label)}</td>
            </tr>`,
            )
            .join("")}</tbody></table></div>`
        : ""
    }
    ${
      milestones.length
        ? `<ul class="milestones milestones--inline">${milestones
            .map((item) => {
              const line = milestoneLine(item);
              return `<li class="milestone"><span class="milestone__scope">${escapeHtml(line.scope)}</span><span class="milestone__text">${escapeHtml(line.text)}</span></li>`;
            })
            .join("")}</ul>`
        : ""
    }`;
}

/* El subtítulo sólo promete la interacción cuando existe: sin eventos en el
 * detalle, ninguna cifra es tocable y decirlo sería mentir. */
function mortalityHint(module) {
  const detail = Array.isArray(module.mortality.detail) ? module.mortality.detail : [];
  if (!detail.length) return "";
  return "<p>Tocá una cifra para ver el detalle por evento.</p>";
}

/* Un dato que nadie informó se dice con palabras, no con un guión.
 *
 * Antes cada tarjeta resolvía la ausencia por su cuenta: las de muertes y la
 * del último parte caían en el «—» que devuelven `formatInteger`/`formatDate`,
 * y sólo la de nacidos muertos recibía un texto propio. Quedaban dos
 * convenciones en el mismo bloque, y encima los guiones se pintaban con el
 * estilo de un valor real, porque la clase de ausencia se pasaba a mano.
 *
 * Se ve únicamente en lotes sin registros —Merino Dohne y Merino Australiano
 * hoy—; en Intensivo, con todas las cifras cargadas, era invisible. */
function mortValue(value, formatter, absent) {
  return value === null || value === undefined ? absent : formatter(value);
}

/* Una cifra sólo se ofrece como tocable si hay eventos de ESE animal en el
 * detalle. Antes el panel prometía «Tocá una cifra» sin que ninguna lo fuera:
 * el detalle existía, pero únicamente se abría desde el desplegable. */
function mortTile(label, value, opts = {}) {
  // La clase la decide el propio texto: `absentClass` ya reconoce «NO
  // INFORMADO» y cualquier «SIN …», así que ninguna tarjeta puede olvidarse de
  // marcar su ausencia ni marcarla cuando tiene dato.
  const cuerpo =
    `<span>${escapeHtml(label)}</span>` +
    `<strong class="${absentClass(value)}">${escapeHtml(value)}</strong>`;
  if (!opts.filter) return `<div class="mort-tile">${cuerpo}</div>`;
  return (
    `<button type="button" class="mort-tile mort-tile--link" data-mort="${escapeHtml(opts.filter)}"` +
    ` aria-label="${escapeHtml(`Ver el detalle de ${label.toLowerCase()}`)}">${cuerpo}` +
    `<span class="mort-tile__hint">Ver detalle</span></button>`
  );
}

function lotMortality(lot, module) {
  const mort = module.mortality;
  const detail = Array.isArray(mort.detail) ? mort.detail : [];
  const conEventos = (tipo) => detail.some((event) => event.animal_type === tipo);
  const stillborn = module.lamb_counts.stillborn;
  const summary = `
    <div class="mort-summary">
      ${mortTile("Muertes de cordero", mortValue(mort.lamb_deaths_accumulated, formatInteger, "SIN REGISTROS"), {
        filter: conEventos("CORDERO") ? "CORDERO" : null,
      })}
      ${mortTile("Muertes de oveja", mortValue(mort.ewe_deaths_accumulated, formatInteger, "SIN REGISTROS"), {
        filter: conEventos("OVEJA") ? "OVEJA" : null,
      })}
      ${mortTile("Nacidos muertos al parto", mortValue(stillborn, formatInteger, "NO INFORMADO"))}
      ${mortTile("Último parte", mortValue(mort.last_report_date, formatDate, "SIN REGISTROS"))}
    </div>`;

  if (!detail.length) {
    return `${summary}<p class="empty-note">SIN REGISTROS de mortalidad en este lote.</p>`;
  }

  const hasMedia = (item) => item && item.has_private_media;
  const anyMedia = detail.some(
    (event) => hasMedia(event) || (Array.isArray(event.cases) && event.cases.some(hasMedia)),
  );
  const mediaChip = (item) =>
    hasMedia(item)
      ? `<span class="mort-media" title="Evidencia multimedia disponible en gestión interna" aria-label="Evidencia multimedia disponible en gestión interna">${MEDIA_ICON}${item.private_media_count > 1 ? `<span class="mort-media__count">${escapeHtml(String(item.private_media_count))}</span>` : ""}</span>`
      : "";

  // El tablero público muestra sólo campos estructurados: fecha, animal,
  // cantidad y causa normalizada. Las descripciones del estado observado son
  // texto libre y quedan en la gestión interna.
  const rows = detail
    .map((event) => {
      const animal = event.animal_type === "OVEJA" ? "Oveja" : "Cordero";
      const cases = Array.isArray(event.cases) ? event.cases : [];
      const parent = `
        <tr data-animal="${escapeHtml(event.animal_type || "")}">
          <td>${escapeHtml(formatDate(event.date))}</td>
          <td>${animal}</td>
          <td class="num">${escapeHtml(formatInteger(event.quantity))}</td>
          <td>${escapeHtml(event.cause_label)} ${mediaChip(event)}</td>
        </tr>`;
      const caseRows = cases
        .map((detailCase) => {
          const a = detailCase.animal_type === "OVEJA" ? "oveja" : "cordero";
          return `
        <tr class="mort-case" data-animal="${escapeHtml(event.animal_type || "")}">
          <td aria-hidden="true"></td>
          <td colspan="3"><span class="mort-case__mark">detalle</span> ${escapeHtml(formatInteger(detailCase.quantity))} ${a} · ${escapeHtml(detailCase.cause_label)} ${mediaChip(detailCase)}</td>
        </tr>`;
        })
        .join("");
      const undescribed = Number(event.undescribed_quantity) || 0;
      const undescribedRow =
        cases.length && undescribed > 0
          ? `<tr class="mort-case" data-animal="${escapeHtml(event.animal_type || "")}"><td aria-hidden="true"></td><td colspan="3"><span class="mort-case__mark">detalle</span> ${escapeHtml(formatInteger(undescribed))} sin detalle individual de causa.</td></tr>`
          : "";
      return parent + caseRows + undescribedRow;
    })
    .join("");

  const mediaNote = anyMedia
    ? " La evidencia multimedia (foto o video) se consulta únicamente en la gestión interna."
    : "";

  return `
    ${summary}
    <details class="mort-drawer" data-mort-drawer>
      <summary>Ver detalle de mortalidad (${detail.length})</summary>
      <p class="mort-drawer__filter" hidden>
        Mostrando sólo <b data-mort-filter-label></b>.
        <button type="button" class="mort-drawer__all">Ver todo</button>
      </p>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Animal</th><th class="num">Cant.</th><th>Causa</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="chart-note">Sin causa informada: “Causa no determinada”; nunca se infiere por contexto. Las descripciones del estado observado se consultan en la gestión interna.${mediaNote}</p>
    </details>`;
}

/* El panel de conciliación de ovejas paridas se retiró de la vista PÚBLICA
 * (responsable, 2026-08-07). Enfrentaba el acumulado derivado de los eventos
 * con el recuento informado desde el campo, su diferencia y la fecha del
 * último control: material de conciliación interna, no lectura operativa del
 * tablero. Ni su encabezado ni sus rótulos sobreviven en este archivo —hay
 * pruebas que lo verifican por texto—, así que acá se lo nombra por lo que
 * hacía, no por cómo se titulaba.
 *
 * Se retiró la PRESENTACIÓN, no el dato. La conciliación sigue entera y viva:
 *   - `build_field_controls` la calcula (services/field_controls.py);
 *   - se publica en la raíz del contrato como `field_controls` y por módulo
 *     como `field_control` (services/web_dashboard.py), y `assertDashboard`
 *     sigue exigiendo esa clave;
 *   - alimenta el motivo de salud FIELD_CONTROL_DIFF (services/system_status.py)
 *     y `lastPhysicalCountDate`, que fecha el recuento en la tarjeta del lote.
 * Sigue disponible para gestión y auditoría; sólo dejó de dibujarse acá. */

/* --------------------------------------------------------- navegación --- */

function currentSection() {
  const hash = (location.hash || "").replace("#", "");
  return SECTIONS.includes(hash) ? hash : "resumen";
}

function showSection(name) {
  SECTIONS.forEach((section) => {
    byId(`view-${section}`).hidden = section !== name;
  });
  document.querySelectorAll(".side-nav__link").forEach((link) => {
    const active = link.dataset.section === name;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  closeDrawer();
  window.scrollTo({ top: 0, behavior: "auto" });
  requestAnimationFrame(() => drawSectionCharts(name));
}

function drawSectionCharts(name) {
  drawIntegralChart(name, CODE_BY_SECTION[name] || null);
  // El canvas de MA sólo existe en la sección de su lote y necesita el ancho
  // real del contenedor: dibujarlo antes de que la sección se muestre daría
  // ancho cero.
  if (maTieneSeguimiento(CODE_BY_SECTION[name])) drawMaChart();
}

function initRouter() {
  window.addEventListener("hashchange", () => showSection(currentSection()));
  byId("nav-toggle").addEventListener("click", toggleDrawer);
  byId("scrim").addEventListener("click", closeDrawer);
  document.querySelectorAll(".side-nav__link").forEach((link) =>
    link.addEventListener("click", () => {
      // El hashchange hará el resto; cerrar el panel en móvil.
      window.setTimeout(closeDrawer, 0);
    }),
  );
  document.addEventListener("change", onChartFilterChange);
  // Las barras observadas son botones: responden a click y a toque.
  document.addEventListener("click", (event) => {
    const button = event.target && event.target.closest && event.target.closest("[data-obsdate]");
    if (button) onChillControl({ target: button });
  });
  document.addEventListener("click", onMortalityTile);
  document.addEventListener("click", onMaClick);
  document.addEventListener("input", onMaInput);
  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => drawSectionCharts(currentSection()));
  });
  showSection(currentSection());
}

/* Tocar una cifra de mortalidad abre el detalle que YA existe y lo acota a ese
 * animal. No se dibuja una tabla nueva ni se recalcula nada: sólo se ocultan
 * las filas del otro animal, y «Ver todo» las devuelve. */
function onMortalityTile(event) {
  const target = event.target && event.target.closest && event.target.closest("[data-mort]");
  const volver = event.target && event.target.closest && event.target.closest(".mort-drawer__all");
  if (!target && !volver) return;

  const panel = (target || volver).closest("section");
  const drawer = panel && panel.querySelector("[data-mort-drawer]");
  if (!drawer) return;

  const tabla = drawer.querySelector("tbody");
  const aviso = drawer.querySelector(".mort-drawer__filter");
  const etiqueta = drawer.querySelector("[data-mort-filter-label]");
  const filtro = volver ? null : target.dataset.mort;

  drawer.open = true;
  for (const fila of tabla ? tabla.querySelectorAll("tr") : []) {
    fila.hidden = Boolean(filtro) && fila.dataset.animal !== filtro;
  }
  if (aviso) aviso.hidden = !filtro;
  if (etiqueta && filtro) {
    etiqueta.textContent = filtro === "OVEJA" ? "muertes de oveja" : "muertes de cordero";
  }
  for (const tile of panel.querySelectorAll("[data-mort]")) {
    tile.classList.toggle("is-active", Boolean(filtro) && tile.dataset.mort === filtro);
  }
  if (!volver) drawer.scrollIntoView({ block: "nearest" });
}

function onChartFilterChange(event) {
  const target = event.target;
  if (onChillControl(event)) return;
  if (!target || !target.dataset || !target.dataset.chart) return;
  const viewKey = target.dataset.chart;
  const state = CHART_STATE[viewKey];
  if (!state) return;
  if (target.dataset.group) {
    state[target.dataset.group][target.dataset.key] = target.checked;
  } else if (target.dataset.filter === "lot") {
    state.lot = target.value;
    state.selected = null;
  } else if (target.dataset.filter === "mode") {
    state.mode = target.value;
  } else if (target.dataset.filter === "from") {
    state.from = target.value;
  } else if (target.dataset.filter === "to") {
    state.to = target.value;
  }
  drawIntegralChart(viewKey, CODE_BY_SECTION[viewKey] || null);
}

function onDrawerKey(event) {
  if (event.key === "Escape") {
    closeDrawer();
    byId("nav-toggle").focus();
  }
}

function toggleDrawer() {
  if (document.body.classList.contains("drawer-open")) closeDrawer();
  else openDrawer();
}

function openDrawer() {
  document.body.classList.add("drawer-open");
  byId("nav-toggle").setAttribute("aria-expanded", "true");
  byId("scrim").hidden = false;
  document.addEventListener("keydown", onDrawerKey);
}

function closeDrawer() {
  if (!document.body.classList.contains("drawer-open")) return;
  document.body.classList.remove("drawer-open");
  byId("nav-toggle").setAttribute("aria-expanded", "false");
  byId("scrim").hidden = true;
  document.removeEventListener("keydown", onDrawerKey);
}

boot();
