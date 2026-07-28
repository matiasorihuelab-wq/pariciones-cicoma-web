"use strict";

/* Tablero público CICOMA — monitoreo de pariciones 2026.
 * Fuente canónica versionada: APP/web_source (WEB es staging generado).
 * Lee exclusivamente data/dashboard.json (esquema 3.4.0), validando el
 * contrato antes de renderizar. Navegación por menú lateral con secciones por
 * lote. Nunca convierte un faltante en cero, nunca presenta un acumulado como
 * valor diario y nunca calcula un total parcial como si fuera completo. */

const DATA_URL = "./data/dashboard.json";
const SUPPORTED_SCHEMA = "3.4.0";
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
  const pendingCodes = ["PENDING_EVENT", "PENDING_LINK", "PENDING_MEDIA"];
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

function lotNames(codes) {
  return (codes || []).map((code) => LOT_LABEL[code] || code).join(", ");
}

// Presentación de un total observado estructurado (COMPLETE/PARTIAL/NOT_REPORTED).
// Un total parcial se identifica con los lotes incluidos y los que faltan; los
// lotes sin recuento nunca se muestran como cero.
function totalDisplay(total) {
  if (!total || total.status === "NOT_REPORTED" || total.value === null) {
    return { value: "SIN REGISTROS", note: null, partial: false };
  }
  if (total.status === "PARTIAL") {
    return {
      value: formatInteger(total.value),
      note: `registrado en ${lotNames(total.lots_included)} · falta ${lotNames(total.lots_missing)}`,
      partial: true,
    };
  }
  return { value: formatInteger(total.value), note: "los tres lotes informados", partial: false };
}

// Tarjeta de un acumulado registrado. La cobertura se comunica en la nota
// discreta al pie de la tarjeta, NO con una etiqueta amarilla grande.
function registeredCard(label, total, opts = {}) {
  const shown = totalDisplay(total);
  const cls = ["stat"];
  if (opts.kpi) cls.push("stat--kpi");
  if (opts.accent) cls.push("stat--accent");
  const note = opts.note !== undefined ? opts.note : shown.note;
  return `
    <article class="${cls.join(" ")}">
      <span class="stat__label">${escapeHtml(label)}</span>
      <strong class="${valueClass("stat__value", shown.value)}">${escapeHtml(shown.value)}</strong>
      ${note ? `<span class="stat__note">${escapeHtml(note)}</span>` : ""}
    </article>`;
}

// Avance publicado por el backend: registrado / esperado, con su base.
function progressCard(label, block, opts = {}) {
  if (!block) return metricCard(label, "SIN REGISTROS");
  const cls = ["stat"];
  if (opts.kpi) cls.push("stat--kpi");
  if (opts.accent) cls.push("stat--accent");
  const value =
    block.percent === null || block.percent === undefined ? "SIN REGISTROS" : formatPercent(block.percent);
  const fraction =
    block.registered === null || block.expected === null
      ? null
      : `${formatInteger(block.registered)} de ${formatInteger(block.expected)}`;
  return `
    <article class="${cls.join(" ")}">
      <span class="stat__label">${escapeHtml(label)}</span>
      <strong class="${valueClass("stat__value", value)}">${escapeHtml(value)}</strong>
      ${fraction ? `<span class="stat__note">${escapeHtml(fraction)}</span>` : ""}
      ${opts.hideBasis ? "" : `<span class="stat__note stat__note--basis">${escapeHtml(block.basis || "")}</span>`}
    </article>`;
}

// Cantidad restante validada por el backend: el frontend nunca hace la resta.
function remainingCard(label, remaining) {
  if (!remaining) return metricCard(label, "SIN RECUENTO");
  if (remaining.status === "OK") {
    return metricCard(label, formatInteger(remaining.value));
  }
  const stateText =
    remaining.status === "ERROR"
      ? "ERROR"
      : remaining.status === "PARCIAL"
        ? "PARCIAL"
        : remaining.status === "NO_INFORMADO"
          ? "NO INFORMADO"
          : "SIN RECUENTO";
  return metricCard(label, stateText, remaining.reason || null);
}

// Restante estimado según los registros. Se muestra siempre con su base para
// que no se confunda con un valor confirmado.
function estimatedRemainingCard(label, block) {
  if (!block) return metricCard(label, "SIN REGISTROS");
  if (block.status === "OK" || block.status === "SEGUN_REGISTROS") {
    return metricCard(label, formatInteger(block.value), block.basis || null);
  }
  const stateText =
    block.status === "ERROR"
      ? "ERROR"
      : block.status === "NO_INFORMADO"
        ? "NO INFORMADO"
        : "SIN REGISTROS";
  return metricCard(label, stateText, block.reason || block.basis || null);
}

// Tabla de indicadores productivos generados por el backend: nombre, valor,
// numerador/denominador y estado. Nada se recalcula en JavaScript; un
// indicador no calculable muestra su estado real, nunca cero.
function indicatorTable(items, caption) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `<p class="empty-note">SIN INDICADORES DISPONIBLES.</p>`;
  const fmtValue = (item) => {
    if (item.status !== "OK" || item.value === null || item.value === undefined) {
      return item.status === "NO_INFORMADO" ? "NO INFORMADO" : "SIN RECUENTO";
    }
    const value = decimalFormatter.format(item.value);
    return item.unit === "%" ? `${value} %` : `${value} ${item.unit}`;
  };
  const fmtFraction = (item) => {
    const num = item.numerator === null || item.numerator === undefined ? "—" : formatNumberShort(item.numerator);
    const den = item.denominator === null || item.denominator === undefined ? "—" : formatNumberShort(item.denominator);
    return `${num} / ${den}`;
  };
  const rows = list
    .map((item) => {
      const state = item.status === "OK" ? "OK" : item.status === "NO_INFORMADO" ? "NO INFORMADO" : "SIN RECUENTO";
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

function renderResumen() {
  const view = byId("view-resumen");
  const ov = DASH.overview;
  const mortality = DASH.mortality_summary || {};
  const totalDeaths = mortality.total_deaths;
  const deaths = totalDeaths === null || totalDeaths === undefined ? "SIN RECUENTO" : formatInteger(totalDeaths);
  const deathsNote =
    totalDeaths === null || totalDeaths === undefined
      ? null
      : `${formatInteger(mortality.lamb_deaths || 0)} corderos · ${formatInteger(mortality.ewe_deaths || 0)} oveja(s)`;
  const coverage = ov.coverage || {};

  // Jerarquía ejecutiva: lo que se mira primero, más grande. Son acumulados
  // REGISTRADOS, no resultados de campaña: el encabezado lo dice.
  const kpis = [
    registeredCard("Ovejas paridas registradas", ov.lambed_ewes, { kpi: true, accent: true, note: null }),
    registeredCard("Corderos nacidos registrados", ov.registered_born_lambs, { kpi: true, accent: true, note: null }),
    progressCard("Avance de ovejas paridas", ov.ewe_progress, { kpi: true, hideBasis: true }),
    progressCard("Avance de corderos nacidos", ov.lamb_progress, { kpi: true, hideBasis: true }),
  ].join("");

  // Contexto secundario, tamaño reducido.
  const secondary = [
    metricCard("Previstas a parir", formatInteger(ov.expected_to_lamb)),
    metricCard("Corderos esperados", formatInteger(ov.expected_lambs)),
    registeredCard("Nacidos vivos registrados", ov.born_alive, { note: null }),
    estimatedRemainingCard("Ovejas restantes según registros", ov.remaining_ewes_estimated),
    estimatedRemainingCard("Corderos restantes estimados", ov.remaining_lambs_estimated),
    metricCard("Muertes registradas", deaths, deathsNote),
  ].join("");

  view.innerHTML = `
    <header class="view__head">
      <p class="eyebrow">Panorama general</p>
      <h1 id="title-resumen">Resumen de la campaña</h1>
      <p class="view__intro">Lo esencial de un vistazo. Cada lote tiene su vista específica en el menú.</p>
    </header>

    <p class="summary-scope"><strong>${escapeHtml(ov.summary_label || "")}</strong></p>
    <div class="kpi-row">${kpis}</div>
    <p class="coverage-note">${escapeHtml(coverage.message || "")}</p>
    <div class="stat-grid">${secondary}</div>

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

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Total campaña</p><h2>Indicadores productivos</h2></div>
        <p>Generados por el sistema con numerador y denominador explícitos.</p>
      </div>
      ${indicatorTable((DASH.productive_indicators || {}).total, "Indicadores productivos totales")}
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

function distributionCard(lot) {
  const module = moduleByCode(lot.code);
  const previsto = module ? formatInteger(module.ewe_counts.expected_to_lamb) : "—";
  const paridas = module ? absentOr(module.ewe_counts.counted_lambed, formatInteger) : "—";
  const nacidos = module ? absentOr(module.lamb_counts.registered_born, formatInteger) : "—";
  const muertos = module ? formatInteger(module.mortality.lamb_deaths_accumulated) : "—";
  const progress = module ? formatPercent(module.ewe_counts.progress?.percent) : "—";
  const state = dataState(module);
  const cell = (label, value) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${absentClass(value)}">${escapeHtml(value)}</dd></div>`;
  return `
    <a class="lot-card" href="#${lot.section}">
      <span class="lot-card__name">${escapeHtml(lot.name)}</span>
      ${lot.breed ? `<span class="lot-card__breed">${escapeHtml(lot.breed)}</span>` : ""}
      <dl class="lot-card__stats">
        ${cell("Previstas", previsto)}
        ${cell("Paridas", paridas)}
        ${cell("Nacidos", nacidos)}
        ${cell("Muertes cordero", muertos)}
        ${cell("Avance ovejas", progress)}
      </dl>
      <span class="lot-card__state tag tag--${state === "ACTUALIZADO" ? "ok" : "pending"}">${escapeHtml(state)}</span>
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
      pieces.push(`${formatInteger(item.counted_live_lambs)} corderos nacidos vivos`);
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
          return `
        <li class="milestone milestone--${escapeHtml(String(item.kind).toLowerCase())}">
          <span class="milestone__date">${escapeHtml(formatDayMonth(item.date))}</span>
          ${line.scope ? `<span class="milestone__scope">${escapeHtml(line.scope)}</span>` : ""}
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

const CHILL_STATE = {};

function defaultChillState(lotCode) {
  return {
    lot: lotCode || "TODOS",
    service: "TODOS",
    from: "",
    to: "",
    curve: { ORIGINAL: true, ADJUSTED: true },
    show: { expected: true, observed: true },
    evaluation: { complete: true, incomplete: true },
    selectedDate: null,
  };
}

function chillState(viewKey, lotCode) {
  if (!CHILL_STATE[viewKey]) CHILL_STATE[viewKey] = defaultChillState(lotCode);
  return CHILL_STATE[viewKey];
}

function inChillRange(state, date) {
  return (!state.from || date >= state.from) && (!state.to || date <= state.to);
}

function matchesChillLot(state, code) {
  return state.lot === "TODOS" || state.lot === code;
}

function matchesChillService(state, row) {
  if (state.service === "TODOS") return true;
  const [code, service] = String(state.service).split(":");
  return row.module_code === code && row.service_code === service;
}

function matchesEvaluation(state, row) {
  return row.complete ? state.evaluation.complete : state.evaluation.incomplete;
}

function chillExpectedRows(state) {
  const rows = ((DASH.chill_public || {}).expected || {}).daily || [];
  return rows.filter(
    (row) =>
      matchesChillLot(state, row.module_code) &&
      matchesChillService(state, row) &&
      inChillRange(state, row.date) &&
      state.curve[row.curve] !== false &&
      matchesEvaluation(state, row),
  );
}

function chillObservedRows(state) {
  const rows = ((DASH.chill_public || {}).observed || {}).daily || [];
  return rows.filter(
    (row) =>
      matchesChillLot(state, row.module_code) &&
      matchesChillService(state, row) &&
      inChillRange(state, row.date) &&
      matchesEvaluation(state, row),
  );
}

function chillHead(lotCode) {
  const chill = DASH.chill_public || {};
  const scope = lotCode ? ` — ${LOT_FULL_NAME[lotCode] || lotCode}` : "";
  return `
      <div class="panel__head">
        <div>
          <p class="eyebrow">Chill Index</p>
          <h2>${escapeHtml(chill.title || "")}${escapeHtml(scope)}</h2>
        </div>
        <p>${escapeHtml(chill.subtitle || "")}</p>
      </div>
      <p class="chill-explain">${escapeHtml(chill.explanation || "")}</p>
      <p class="chill-phrase">${escapeHtml(chill.exposure_phrase || "")}.</p>
      <p class="chill-disclaimer">${escapeHtml(chill.forecast_disclaimer || "")}</p>`;
}

function chillServiceOptions(state) {
  const options = [`<option value="TODOS">Todos los servicios</option>`];
  for (const lot of DASH.lambing_curves?.lots || []) {
    if (!matchesChillLot(state, lot.code)) continue;
    for (const service of lot.services || []) {
      const value = `${lot.code}:${service.code}`;
      options.push(
        `<option value="${escapeHtml(value)}" ${state.service === value ? "selected" : ""}>${escapeHtml(
          `${LOT_LABEL[lot.code] || lot.code} · ${service.service_type}`,
        )}</option>`,
      );
    }
  }
  return options.join("");
}

function chillFilters(viewKey, lotCode, state) {
  const lotSelect = lotCode
    ? ""
    : `
      <label class="filter">
        <span>Lote</span>
        <select data-chill="${escapeHtml(viewKey)}" data-filter="lot">
          <option value="TODOS">Todos los lotes</option>
          ${LOTS.map(
            (lot) =>
              `<option value="${lot.code}" ${state.lot === lot.code ? "selected" : ""}>${escapeHtml(lot.name)}</option>`,
          ).join("")}
        </select>
      </label>`;
  const check = (group, key, label) => `
    <label class="toggle">
      <input type="checkbox" data-chill="${escapeHtml(viewKey)}" data-cgroup="${group}" data-ckey="${key}" ${
        state[group][key] ? "checked" : ""
      } />
      <span>${escapeHtml(label)}</span>
    </label>`;
  return `
    <div class="chart-filters">
      ${lotSelect}
      <label class="filter">
        <span>Servicio</span>
        <select data-chill="${escapeHtml(viewKey)}" data-filter="service">${chillServiceOptions(state)}</select>
      </label>
      <label class="filter">
        <span>Desde</span>
        <input type="date" data-chill="${escapeHtml(viewKey)}" data-filter="from" value="${escapeHtml(state.from)}" />
      </label>
      <label class="filter">
        <span>Hasta</span>
        <input type="date" data-chill="${escapeHtml(viewKey)}" data-filter="to" value="${escapeHtml(state.to)}" />
      </label>
    </div>
    <div class="chart-toggles" role="group" aria-label="Series y evaluación del Chill Index">
      ${check("show", "expected", "Proyección esperada")}
      ${check("show", "observed", "Nacimientos registrados")}
      ${check("curve", "ORIGINAL", "Curva original")}
      ${check("curve", "ADJUSTED", "Curva ajustada")}
      ${check("evaluation", "complete", "Evaluación completa")}
      ${check("evaluation", "incomplete", "Evaluación incompleta")}
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

const LOT_SHORT = { INTENSIVO: "Int", DOHNE: "Dohne", MA: "MA" };

// Tarjeta de un día de exposición esperada. `exposure` es la cifra a mostrar;
// `lots` es el desglose por lote (sólo cuando se ven todos).
function chillDay(day, exposure, lots) {
  const cat = day.risk_category;
  const rel = dayRelative(day.date);
  const complete = day.cohort_72h_complete
    ? ""
    : `<span class="tag tag--incompleto">${escapeHtml(INCOMPLETE_RISK_LABEL)}</span>`;
  return `
    <li class="chill-day risk-${escapeHtml(riskClass(cat))}">
      <div class="chill-day__head">
        <span class="chill-day__date">
          ${rel ? `<span class="chill-day__rel">${escapeHtml(rel)}</span>` : ""}
          <span class="chill-day__day">${escapeHtml(formatDate(day.date, { short: true }))}</span>
        </span>
        <span class="risk-pill risk-pill--${escapeHtml(riskClass(cat))}">${escapeHtml(riskLabel(cat))}</span>
      </div>
      <span class="chill-day__value"><strong>${escapeHtml(formatExposure(exposure))}</strong> <span>corderos expuestos</span></span>
      ${lots ? `<span class="chill-day__lots">${lots}</span>` : ""}
      ${complete}
    </li>`;
}

/* --- A. Bloque PREVISTO ---------------------------------------------- */

function chillExpectedSection(state) {
  const chill = DASH.chill_public || {};
  const expected = chill.expected || {};
  const days = Array.isArray(chill.daily) ? chill.daily : [];
  if (!state.show.expected) return "";
  if (!days.length) {
    return `<p class="empty-note">SIN DISTRIBUCIÓN DE PARTOS CARGADA — el cálculo se habilita cuando exista curva de partos.</p>`;
  }
  const visible = days.filter((day) => inChillRange(state, day.date));
  const cards = visible
    .map((day) => {
      const lots =
        state.lot === "TODOS"
          ? LOTS.map(
              (lot) => `${LOT_SHORT[lot.code]} ${escapeHtml(formatExposure((day.by_lot || {})[lot.code]))}`,
            ).join(" · ")
          : null;
      const exposure = state.lot === "TODOS" ? day.total_exposed : (day.by_lot || {})[state.lot];
      return chillDay(day, exposure, lots);
    })
    .join("");

  const rows = chillExpectedRows(state);
  const table = rows.length
    ? `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Fecha</th><th>Lote</th><th>Servicio</th><th class="num">Corderos esperados</th>
          <th>Chill D</th><th>D+1</th><th>D+2</th><th>Riesgo 72 h</th><th>Evaluación</th><th>Curva</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (row) => `
          <tr>
            <td>${escapeHtml(formatDayMonth(row.date))}</td>
            <td>${escapeHtml(LOT_LABEL[row.module_code] || row.module_code)}</td>
            <td>${escapeHtml(row.service_type || "Sin servicio asociado")}</td>
            <td class="num">${escapeHtml(formatDecimal(row.expected_lambs))}</td>
            <td>${escapeHtml(riskLabel(row.risk_d))}</td>
            <td>${escapeHtml(riskLabel(row.risk_d1))}</td>
            <td>${escapeHtml(riskLabel(row.risk_d2))}</td>
            <td><span class="risk-pill risk-pill--${escapeHtml(riskClass(row.max_risk))}">${escapeHtml(riskLabel(row.max_risk))}</span></td>
            <td>${row.complete ? "Completa" : escapeHtml(INCOMPLETE_RISK_LABEL)}</td>
            <td>${row.curve === "ADJUSTED" ? "Ajustada" : "Original"}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>
    </div>`
    : `<p class="empty-note">SIN FILAS PREVISTAS para los filtros elegidos.</p>`;

  return `
    <section class="chill-section">
      <h3 class="chill-section__title">${escapeHtml(expected.title || "")}</h3>
      <p class="chill-mode">${escapeHtml(expected.daily_title || "")}</p>
      <ul class="chill-list">${cards}</ul>
      ${table}
    </section>`;
}

/* --- B. Bloque OBSERVADO --------------------------------------------- */

function chillObservedSection(viewKey, state) {
  const observed = (DASH.chill_public || {}).observed || {};
  if (!state.show.observed) return "";
  const rows = chillObservedRows(state);
  if (!rows.length) {
    const messages = Array.isArray(observed.messages) ? observed.messages : [];
    const notes = messages.length ? messages : ["Sin registros diarios de nacimientos para este lote."];
    return `
    <section class="chill-section chill-section--observed">
      <h3 class="chill-section__title">${escapeHtml(observed.title || "")}</h3>
      ${notes.map((text) => `<p class="empty-note">${escapeHtml(text)}</p>`).join("")}
    </section>`;
  }

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

/* --- Información secundaria (ya no domina el bloque) ------------------ */

function chillSecondary(lotCode) {
  const chill = DASH.chill_public || {};
  const coverage = lotCode ? (chill.coverage?.by_module || {})[lotCode] : chill.coverage;
  if (!coverage) return "";
  const cells = [
    ["Evaluados hasta la fecha", formatExposure(coverage.evaluated)],
    ["Con evaluación completa", formatExposure(coverage.classified)],
    [INCOMPLETE_RISK_LABEL, formatExposure(coverage.incomplete)],
    ["Pendientes de evaluar", formatExposure(coverage.pending)],
    ["Corderos esperados (denominador)", formatInteger(coverage.expected_total)],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  const notice = chill.accumulated_notice || {};
  return `
    <details class="chill-secondary">
      <summary>Cobertura de la evaluación ambiental (información secundaria)</summary>
      <dl class="control-grid">${cells}</dl>
      ${[coverage.incomplete_reason, coverage.pending_reason]
        .filter(Boolean)
        .map((text) => `<p class="chart-note">${escapeHtml(text)}</p>`)
        .join("")}
      ${notice.message ? `<p class="chart-note">${escapeHtml(notice.message)}</p>` : ""}
      ${chill72h(chill.exposure_72h, lotCode)}
    </details>`;
}

/* Consolidado de 72 h de lo PREVISTO: cada cordero esperado una sola vez. */
function chill72h(exposure, lotCode) {
  if (!exposure || typeof exposure !== "object") return "";
  const scope = lotCode ? (exposure.by_module || {})[lotCode] || {} : exposure;
  const cells = [...RISK_ORDER, INCOMPLETE_RISK]
    .map((cat) => {
      const value = scope[cat];
      if (value === undefined) return "";
      return `
        <div class="expo-cell expo-cell--${escapeHtml(riskClass(cat))}">
          <span class="expo-cell__label">${escapeHtml(riskLabel(cat))}</span>
          <strong>${escapeHtml(formatExposure(value))}</strong>
        </div>`;
    })
    .join("");
  return `
    <div class="chill-72h">
      <p class="chill-mode">Resultado previsto de las primeras 72 horas — cada cordero esperado se cuenta una sola vez, por su nivel de riesgo más alto.</p>
      <div class="expo-grid">${cells}</div>
    </div>`;
}

/* --- Panel completo --------------------------------------------------- */

function chillPanel(viewKey, lotCode) {
  const chill = DASH.chill_public || {};
  const state = chillState(viewKey, lotCode);
  const stale = chill.update_status && chill.update_status.stale;
  return `
    ${stale ? `<p class="tag tag--incompleto">El Chill Index no está actualizado.</p>` : ""}
    ${chillFilters(viewKey, lotCode, state)}
    <div id="chill-body-${escapeHtml(viewKey)}">
      ${chillExpectedSection(state)}
      ${chillObservedSection(viewKey, state)}
      ${chillSecondary(lotCode)}
      <p class="chill-source">Fuente: INIA-GRAS · ${iniaLink()}</p>
    </div>`;
}

function renderChillBody(viewKey, lotCode) {
  const host = byId(`chill-body-${viewKey}`);
  if (!host) return;
  const state = chillState(viewKey, lotCode);
  host.innerHTML = `
      ${chillExpectedSection(state)}
      ${chillObservedSection(viewKey, state)}
      ${chillSecondary(lotCode)}
      <p class="chill-source">Fuente: INIA-GRAS · ${iniaLink()}</p>`;
}

function onChillControl(event) {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.chill) return false;
  const viewKey = target.dataset.chill;
  const state = CHILL_STATE[viewKey];
  if (!state) return false;
  if (target.dataset.obsdate !== undefined) {
    state.selectedDate = state.selectedDate === target.dataset.obsdate ? null : target.dataset.obsdate;
  } else if (target.dataset.cgroup) {
    state[target.dataset.cgroup][target.dataset.ckey] = target.checked;
  } else if (target.dataset.filter === "lot") {
    state.lot = target.value;
    state.service = "TODOS";
    state.selectedDate = null;
  } else if (target.dataset.filter === "service") {
    state.service = target.value;
  } else if (target.dataset.filter === "from") {
    state.from = target.value;
  } else if (target.dataset.filter === "to") {
    state.to = target.value;
  } else {
    return false;
  }
  renderChillBody(viewKey, CODE_BY_SECTION[viewKey] || null);
  return true;
}

/* ------------------------------------------------------------ por lote --- */

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

    <section class="panel">
      <div class="panel__head"><h2>Recuentos registrados del lote</h2><p>${escapeHtml(DASH.overview.summary_label || "")}</p></div>
      <div class="stat-grid">${lotCounts(module)}</div>
      ${lotCountsNote(module)}
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Indicadores productivos</h2><p>Generados por el sistema con numerador y denominador explícitos.</p></div>
      ${indicatorTable(((DASH.productive_indicators || {}).by_module || {})[lot.code], `Indicadores de ${lot.name}`)}
    </section>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Curva integral</p><h2>Curva prevista, evolución real y mortalidad</h2></div>
        <p>Comparación entre la distribución prevista de partos, los registros reales acumulados y diarios, y la mortalidad informada durante la campaña.</p>
      </div>
      ${curvePanel(lot.section, lot.code)}
    </section>

    ${servicesPanel(curve)}

    ${milestonesPanel(lot.code)}

    <section class="panel">
      ${chillHead(lot.code)}
      ${chillPanel(lot.section, lot.code)}
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Mortalidad</h2><p>Tocá una cifra para ver el detalle por evento.</p></div>
      ${lotMortality(lot, module)}
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Control acumulado de campo</h2><p>Ovejas paridas: calculado desde los eventos frente al control informado.</p></div>
      ${lotControl(module)}
    </section>

    <section class="panel panel--flat">
      <div class="panel__head">
        <div><p class="eyebrow">Ecografía</p><h2>Composición reproductiva</h2></div>
        <p>Carga fetal confirmada de la base productiva vigente.</p>
      </div>
      ${lotEcografia(module)}
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

function lotCounts(module) {
  const iv = module.initial_values;
  const ec = module.ewe_counts;
  const lc = module.lamb_counts;
  const mort = module.mortality;
  const paridas =
    ec.counted_lambed === null
      ? "SIN RECUENTO"
      : `${formatInteger(ec.counted_lambed)} de ${formatInteger(ec.expected_to_lamb)}`;
  const nacidos =
    lc.registered_born === null
      ? "SIN RECUENTO"
      : `${formatInteger(lc.registered_born)} de ${formatInteger(lc.expected_total)}`;
  // Los restantes vienen validados por el backend (valor/estado/motivo):
  // el frontend no resta y jamás muestra un restante negativo.
  return [
    metricCard("Servidas", formatInteger(iv.served)),
    metricCard("Preñadas", formatInteger(iv.expected_to_lamb)),
    metricCard("Corderos esperados", formatInteger(iv.expected_lambs)),
    metricCard("Ovejas paridas registradas", paridas),
    metricCard("Corderos nacidos registrados", nacidos, lambRegisteredNote(lc)),
    progressCard("Avance de ovejas paridas", ec.progress, { hideBasis: true }),
    progressCard("Avance de corderos nacidos", lc.progress, { hideBasis: true }),
    metricCard("Nacidos vivos", lc.confirmed_live === null || lc.confirmed_live === undefined ? "SIN RECUENTO" : formatInteger(lc.confirmed_live)),
    metricCard("Nacidos muertos al parto", lc.stillborn === null || lc.stillborn === undefined ? "NO INFORMADO" : formatInteger(lc.stillborn)),
    remainingCard("Ovejas restantes", ec.remaining),
    estimatedRemainingCard("Corderos restantes estimados", lc.remaining_estimated),
    metricCard("Muertes de cordero", formatInteger(mort.lamb_deaths_accumulated)),
    metricCard("Muertes de oveja", formatInteger(mort.ewe_deaths_accumulated)),
  ].join("");
}

// Aclaración breve al pie de «Corderos nacidos registrados»: qué se informó y
// qué no. Un mínimo confirmado jamás se presenta como el total exacto.
function lambRegisteredNote(lambCounts) {
  if (lambCounts.registered_born === null) return null;
  if (lambCounts.registered_born_is_minimum) {
    const live = formatInteger(lambCounts.confirmed_live);
    return `${live} nacidos vivos reportados. ${lambCounts.stillborn_message || "Nacidos muertos al parto: no informados."}`;
  }
  return null;
}

function lotCountsNote(module) {
  const note = lambRegisteredNote(module.lamb_counts);
  if (!note) return "";
  return `<p class="chart-note">Corderos nacidos registrados: ${escapeHtml(note)} Es la cantidad mínima confirmada hasta el momento, no el total exacto.</p>`;
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
  eweDeath: "#8f2a1d",
  stillborn: "#d97a1e",
};

function defaultChartState(lotCode) {
  return {
    lot: lotCode || "TOTAL",
    mode: "cumulative",
    series: { original: true, adjusted: true, observed: true },
    mortality: { lamb: true, ewe: true, stillborn: true },
    from: "",
    to: "",
    selected: null,
  };
}

function chartState(viewKey, lotCode) {
  if (!CHART_STATE[viewKey]) CHART_STATE[viewKey] = defaultChartState(lotCode);
  return CHART_STATE[viewKey];
}

function curvePanel(viewKey, lotCode) {
  const curves = DASH.lambing_curves || {};
  if (!Array.isArray(curves.lots) || !curves.lots.length) {
    return `<p class="empty-note">SIN CURVA CARGADA — el gráfico se habilita cuando exista curva de partos.</p>`;
  }
  const state = chartState(viewKey, lotCode);
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
  const serviceOptions = serviceFilterOptions(state.lot);
  return `
    <div class="chart-filters">
      ${lotOptions}
      <label class="filter">
        <span>Servicio</span>
        <select data-chart="${escapeHtml(viewKey)}" data-filter="service">${serviceOptions}</select>
      </label>
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
      ${toggle(viewKey, "series", "adjusted", "Curva prevista ajustada", state.series.adjusted, CURVE_COLORS.adjusted)}
      ${toggle(viewKey, "series", "observed", "Evolución real observada", state.series.observed, CURVE_COLORS.observed)}
      ${toggle(viewKey, "mortality", "lamb", "Mortalidad de corderos", state.mortality.lamb, CURVE_COLORS.lambDeath)}
      ${toggle(viewKey, "mortality", "ewe", "Mortalidad de ovejas", state.mortality.ewe, CURVE_COLORS.eweDeath)}
      ${toggle(viewKey, "mortality", "stillborn", "Nacidos muertos al parto", state.mortality.stillborn, CURVE_COLORS.stillborn)}
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

function serviceFilterOptions(lotCode) {
  const options = [`<option value="TODOS">Todos los servicios</option>`];
  const lots = (DASH.lambing_curves?.lots || []).filter(
    (lot) => lotCode === "TOTAL" || lot.code === lotCode,
  );
  for (const lot of lots) {
    for (const service of lot.services || []) {
      const value = `${lot.code}:${service.code}`;
      options.push(
        `<option value="${escapeHtml(value)}">${escapeHtml(`${LOT_LABEL[lot.code] || lot.code} · ${service.service_type}`)}</option>`,
      );
    }
  }
  return options.join("");
}

// Datos del gráfico para el lote/estado actual. Cada serie conserva su origen:
// la agregación "Total" suma para visualizar, sin perder la identidad del lote.
function chartData(state) {
  const curves = DASH.lambing_curves || {};
  const lots = (curves.lots || []).filter((lot) => state.lot === "TOTAL" || lot.code === state.lot);
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
    for (const point of lot.observed_checkpoints || []) {
      if (!inRange(point.date)) continue;
      checkpoints.push({ ...point, module_code: lot.code });
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
  const stillbornSeries = ((DASH.stillborn_daily || {}).series || []).filter(
    (row) => (state.lot === "TOTAL" || row.module_code === state.lot) && inRange(row.date),
  );

  const dates = new Set([...original.keys(), ...adjusted.keys(), ...observed.keys()]);
  mortality.forEach((row) => dates.add(row.date));
  stillbornSeries.forEach((row) => dates.add(row.date));
  checkpoints.forEach((point) => dates.add(point.date));
  return {
    dates: [...dates].sort(),
    original,
    adjusted,
    observed,
    checkpoints,
    mortality,
    stillborn: stillbornSeries,
    adjustedLots: (curves.adjusted_lots || []).filter(
      (code) => state.lot === "TOTAL" || code === state.lot,
    ),
  };
}

function mortalityAt(data, date, kind) {
  if (kind === "stillborn") {
    return data.stillborn
      .filter((row) => row.date === date)
      .reduce((total, row) => total + (Number(row.quantity) || 0), 0);
  }
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
        .filter((point) => point.value !== null && point.value !== undefined);
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
      const pct = point.cumulative_ewes_pct;
      const y = cumulative && pct !== null && pct !== undefined
        ? padding.top + plotHeight - Math.min(Number(pct), 1) * plotHeight
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
        state.mortality.stillborn ? mortalityAt(data, date, "stillborn") : 0,
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
      ["stillborn", CURVE_COLORS.stillborn, deathBar],
    ];
    for (const [kind, colour, offset] of kinds) {
      if (!state.mortality[kind]) continue;
      const value = mortalityAt(data, date, kind);
      if (!value) continue;
      const barHeight = (value / maxDeaths) * (bandHeight - 8);
      context.fillStyle = colour;
      context.fillRect(centre + offset, bandTop + bandHeight - barHeight, deathBar, barHeight);
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
  if (state.mode === "cumulative") {
    notes.push("Líneas: avance acumulado de cada serie. Barras inferiores: mortalidad diaria informada.");
  } else {
    notes.push("Barras: valores diarios de cada serie. Barras inferiores: mortalidad diaria informada.");
  }
  for (const point of data.checkpoints) {
    notes.push(
      `Último recuento acumulado al ${formatDayMonth(point.date)} en ${LOT_FULL_NAME[point.module_code] || point.module_code}: ` +
        `${formatInteger(point.lambed_ewes)} ovejas paridas y ${formatInteger(point.confirmed_live_lambs ?? point.registered_born_lambs)} corderos nacidos vivos. ` +
        `Sin distribución diaria informada.`,
    );
  }
  if (state.lot === "TOTAL" && data.adjustedLots.length && data.adjustedLots.length < LOTS.length) {
    notes.push(
      `La curva ajustada existe sólo en ${lotNames(data.adjustedLots)}: se consulta en la vista de ese lote para no mezclar lotes.`,
    );
  }
  if ((DASH.stillborn_daily || {}).status === "NO_INFORMADO") {
    notes.push((DASH.stillborn_daily || {}).message || "");
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

function tooltipHtml(data, date) {
  const rows = [`<strong>${escapeHtml(formatDate(date))}</strong>`];
  const orig = data.original.get(date);
  if (orig) {
    rows.push(
      `Previsto: ${escapeHtml(formatDecimal(orig.ewes))} ovejas · ${escapeHtml(formatDecimal(orig.lambs))} corderos`,
    );
  }
  const obs = data.observed.get(date);
  if (obs) {
    rows.push(`Observado: ${escapeHtml(formatInteger(obs.ewes))} ovejas · ${escapeHtml(formatInteger(obs.lambs))} corderos`);
  }
  for (const point of data.checkpoints.filter((item) => item.date === date)) {
    rows.push(`Recuento acumulado informado en esta fecha (${escapeHtml(LOT_LABEL[point.module_code] || point.module_code)})`);
  }
  for (const row of data.mortality.filter((item) => item.date === date)) {
    rows.push(
      `${escapeHtml(row.animal_type === "OVEJA" ? "Oveja" : "Cordero")}: ${escapeHtml(formatInteger(row.quantity))} · ` +
        `${escapeHtml(row.cause_label)} · ${escapeHtml(row.death_moment_label)} · ${escapeHtml(row.service_label)}`,
    );
  }
  for (const row of data.stillborn.filter((item) => item.date === date)) {
    rows.push(`Nacidos muertos al parto: ${escapeHtml(formatInteger(row.quantity))}`);
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
  const stillborn = data.stillborn.filter((item) => item.date === date);
  const risk = (DASH.chill_public?.daily || []).find((day) => day.date === date);
  const milestones = (DASH.campaign_milestones?.items || []).filter(
    (item) => item.date === date && (state.lot === "TOTAL" || item.module_code === state.lot),
  );
  const services = (DASH.lambing_curves?.lots || [])
    .filter((lot) => state.lot === "TOTAL" || lot.code === state.lot)
    .flatMap((lot) => (lot.services || []).map((service) => `${LOT_LABEL[lot.code]} · ${service.service_type}`));

  const cell = (label, value) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${absentClass(value)}">${escapeHtml(value)}</dd></div>`;
  const lambDeaths = deaths
    .filter((row) => row.animal_type === "CORDERO")
    .reduce((total, row) => total + row.quantity, 0);
  const eweDeaths = deaths
    .filter((row) => row.animal_type === "OVEJA")
    .reduce((total, row) => total + row.quantity, 0);
  const stillbornTotal = stillborn.reduce((total, row) => total + row.quantity, 0);

  host.innerHTML = `
    <h3 class="day-detail__title">Detalle del ${escapeHtml(formatDate(date))}</h3>
    <dl class="control-grid">
      ${cell("Lote", state.lot === "TOTAL" ? "Total campaña" : LOT_FULL_NAME[state.lot] || state.lot)}
      ${cell("Servicio", services.length ? services.join(" · ") : "Sin servicio asociado")}
      ${cell("Ovejas previstas", orig ? formatDecimal(orig.ewes) : "SIN CURVA")}
      ${cell("Corderos previstos", orig ? formatDecimal(orig.lambs) : "SIN CURVA")}
      ${cell("Ovejas previstas (ajustada)", adj ? formatDecimal(adj.ewes) : "SIN AJUSTE")}
      ${cell("Ovejas paridas registradas ese día", obs ? formatInteger(obs.ewes) : "SIN REGISTROS")}
      ${cell("Corderos nacidos registrados ese día", obs ? formatInteger(obs.lambs) : "SIN REGISTROS")}
      ${cell("Nacidos muertos al parto", stillborn.length ? formatInteger(stillbornTotal) : "NO INFORMADO")}
      ${cell("Corderos muertos posteriormente", deaths.length ? formatInteger(lambDeaths) : "SIN REGISTROS")}
      ${cell("Ovejas muertas", deaths.length ? formatInteger(eweDeaths) : "SIN REGISTROS")}
      ${cell("Riesgo climático previsto", risk ? riskLabel(risk.risk_category) : "SIN DATO")}
    </dl>
    ${checkpoints
      .map(
        (point) => `
      <p class="day-detail__checkpoint"><span class="tag tag--muted">ACUMULADO</span>
      Recuento acumulado informado en esta fecha (${escapeHtml(LOT_FULL_NAME[point.module_code] || point.module_code)}):
      ${escapeHtml(formatInteger(point.lambed_ewes))} ovejas paridas y
      ${escapeHtml(formatInteger(point.confirmed_live_lambs ?? point.registered_born_lambs))} corderos nacidos vivos.
      No es un valor diario.</p>`,
      )
      .join("")}
    ${
      deaths.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Animal</th><th class="num">Cant.</th><th>Causa</th><th>Momento</th><th>Servicio</th></tr></thead><tbody>${deaths
            .map(
              (row) => `<tr>
              <td>${escapeHtml(row.animal_type === "OVEJA" ? "Oveja" : "Cordero")}</td>
              <td class="num">${escapeHtml(formatInteger(row.quantity))}</td>
              <td>${escapeHtml(row.cause_label)}</td>
              <td>${escapeHtml(row.death_moment_label)}</td>
              <td>${escapeHtml(row.service_label)}</td>
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

function lotMortality(lot, module) {
  const mort = module.mortality;
  const detail = Array.isArray(mort.detail) ? mort.detail : [];
  const summary = `
    <div class="mort-summary">
      <div class="mort-tile"><span>Muertes de cordero</span><strong>${escapeHtml(formatInteger(mort.lamb_deaths_accumulated))}</strong></div>
      <div class="mort-tile"><span>Muertes de oveja</span><strong>${escapeHtml(formatInteger(mort.ewe_deaths_accumulated))}</strong></div>
      <div class="mort-tile"><span>Nacidos muertos al parto</span><strong class="${absentClass(module.lamb_counts.stillborn === null ? "NO INFORMADO" : "")}">${escapeHtml(module.lamb_counts.stillborn === null || module.lamb_counts.stillborn === undefined ? "NO INFORMADO" : formatInteger(module.lamb_counts.stillborn))}</strong></div>
      <div class="mort-tile"><span>Último parte</span><strong>${escapeHtml(formatDate(mort.last_report_date))}</strong></div>
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
        <tr>
          <td>${escapeHtml(formatDate(event.date))}</td>
          <td>${animal}</td>
          <td class="num">${escapeHtml(formatInteger(event.quantity))}</td>
          <td>${escapeHtml(event.cause_label)} ${mediaChip(event)}</td>
        </tr>`;
      const caseRows = cases
        .map((detailCase) => {
          const a = detailCase.animal_type === "OVEJA" ? "oveja" : "cordero";
          return `
        <tr class="mort-case">
          <td aria-hidden="true"></td>
          <td colspan="3"><span class="mort-case__mark">detalle</span> ${escapeHtml(formatInteger(detailCase.quantity))} ${a} · ${escapeHtml(detailCase.cause_label)} ${mediaChip(detailCase)}</td>
        </tr>`;
        })
        .join("");
      const undescribed = Number(event.undescribed_quantity) || 0;
      const undescribedRow =
        cases.length && undescribed > 0
          ? `<tr class="mort-case"><td aria-hidden="true"></td><td colspan="3"><span class="mort-case__mark">detalle</span> ${escapeHtml(formatInteger(undescribed))} sin detalle individual de causa.</td></tr>`
          : "";
      return parent + caseRows + undescribedRow;
    })
    .join("");

  const mediaNote = anyMedia
    ? " La evidencia multimedia (foto o video) se consulta únicamente en la gestión interna."
    : "";

  return `
    ${summary}
    <details class="mort-drawer">
      <summary>Ver detalle de mortalidad (${detail.length})</summary>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Animal</th><th class="num">Cant.</th><th>Causa</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="chart-note">Sin causa informada: “Causa no determinada”; nunca se infiere por contexto. Las descripciones del estado observado se consultan en la gestión interna.${mediaNote}</p>
    </details>`;
}

function lotControl(module) {
  const control = module.field_control;
  if (!control) return `<p class="empty-note">SIN CONTROL DISPONIBLE.</p>`;
  const statusLabels = {
    COINCIDE: "Coincide",
    DIFERENCIA: "Diferencia",
    SIN_CONTROL_RECIENTE: "Sin control reciente",
    CONCILIADO: "Conciliado",
  };
  const tone = control.status === "DIFERENCIA" ? "ojo" : control.status === "COINCIDE" || control.status === "CONCILIADO" ? "ok" : "pending";
  const calculated = control.calculated === null ? "SIN RECUENTO" : formatInteger(control.calculated);
  const reported =
    control.reported_accumulated === null ? "SIN CONTROL" : formatInteger(control.reported_accumulated);
  const difference = control.difference === null ? "—" : formatInteger(control.difference);
  const lastControl = formatDate(control.reported_date);
  return `
    <div class="control-grid">
      <div><dt>Calculado desde eventos</dt><dd class="${absentClass(calculated)}">${escapeHtml(calculated)}</dd></div>
      <div><dt>Control informado</dt><dd class="${absentClass(reported)}">${escapeHtml(reported)}</dd></div>
      <div><dt>Diferencia</dt><dd class="${absentClass(difference)}">${escapeHtml(difference)}</dd></div>
      <div><dt>Último control</dt><dd class="${absentClass(lastControl)}">${escapeHtml(lastControl)}</dd></div>
    </div>
    <p class="control-status"><span class="tag tag--${tone}">${escapeHtml(statusLabels[control.status] || control.status)}</span>
    El acumulado informado es un control, no un incremento diario.</p>`;
}

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
  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => drawSectionCharts(currentSection()));
  });
  showSection(currentSection());
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
    const serviceSelect = document.querySelector(`[data-chart="${viewKey}"][data-filter="service"]`);
    if (serviceSelect) serviceSelect.innerHTML = serviceFilterOptions(state.lot);
  } else if (target.dataset.filter === "service") {
    state.service = target.value;
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
