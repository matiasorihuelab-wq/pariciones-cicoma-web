"use strict";

/* Tablero público CICOMA — monitoreo de pariciones 2026.
 * Lee exclusivamente data/dashboard.json (esquema 3.1.0). Navegación por menú
 * lateral con secciones por lote. Nunca convierte un faltante en cero. */

const DATA_URL = "./data/dashboard.json";
const SUPPORTED_SCHEMA = "3.1.0";
const SECTIONS = ["resumen", "intensivo", "dohne", "ma"];
const LOTS = [
  { code: "INTENSIVO", section: "intensivo", name: "Intensivo", breed: "Merino Australiano X Hampshire Down" },
  { code: "DOHNE", section: "dohne", name: "Merino Dohne", breed: null },
  { code: "MA", section: "ma", name: "Merino Australiano", breed: null },
];
const CODE_BY_SECTION = Object.fromEntries(LOTS.map((lot) => [lot.section, lot.code]));
const RISK_ORDER = ["SIN_RIESGO", "BAJO", "MEDIO", "ALTO", "CRITICO"];

let DASH = null;
let AGE_TIMER = null;
const CURVE_SERIES = {};

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
  if (category === "RIESGO_72H_INCOMPLETO") return "incompleto";
  return "unknown";
}

function riskLabel(category) {
  if (!category) return "NO INFORMADO";
  if (category === "SIN_RIESGO") return "SIN RIESGO";
  if (category === "RIESGO_72H_INCOMPLETO") return "RIESGO 72 H INCOMPLETO";
  if (category === "NO_DETERMINADO") return "NO DETERMINADO";
  return String(category).replaceAll("_", " ");
}

/* ---------------------------------------------------------------- carga --- */

function assertDashboard(data) {
  if (!data || typeof data !== "object") throw new Error("JSON inválido");
  if (data.schema_version !== SUPPORTED_SCHEMA) {
    throw new Error(`Versión de esquema no compatible: ${data.schema_version}`);
  }
  for (const field of ["overview", "system_health", "chill_public", "field_controls"]) {
    if (!data[field] || typeof data[field] !== "object") throw new Error(`Falta ${field}`);
  }
  if (!Array.isArray(data.modules)) throw new Error("Falta la lista de módulos");
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

function ageMinutes() {
  const generated = DASH.generated_at || DASH.system_health?.generated_at;
  if (!generated) return null;
  const stamp = new Date(generated);
  if (Number.isNaN(stamp.getTime())) return null;
  return Math.max(0, (Date.now() - stamp.getTime()) / 60000);
}

function ageText(minutes) {
  if (minutes === null) return "—";
  if (minutes < 60) return `hace ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

// Estado efectivo: el del servidor más la antigüedad evaluada en el cliente.
// Aunque la PC deje de publicar, el navegador detecta la web atrasada (§3.5).
function currentHealth() {
  const base = DASH.system_health || { state: "OK", reasons: [] };
  const reasons = Array.isArray(base.reasons) ? base.reasons.slice() : [];
  let state = base.state === "OJO" ? "OJO" : "OK";
  const minutes = ageMinutes();
  const maxAge = Number(DASH.max_age_minutes || base.max_age_minutes || 60);
  if (minutes !== null && minutes > maxAge) {
    state = "OJO";
    reasons.push({ code: "STALE_CLIENT", message: "La información publicada está atrasada." });
  }
  return { state, reasons, minutes, maxAge };
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
  const count = health.reasons.length;
  byId("health-pop-count").textContent = isOjo
    ? `${count} ${count === 1 ? "incidencia" : "incidencias"}`
    : "Todo actualizado";
  const reasons = byId("health-pop-reasons");
  reasons.innerHTML = isOjo
    ? health.reasons.map((r) => `<li>${escapeHtml(r.message)}</li>`).join("")
    : "";
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

function renderResumen() {
  const view = byId("view-resumen");
  const ov = DASH.overview;
  const deaths =
    ov.lamb_deaths === null && ov.ewe_deaths === null
      ? "SIN RECUENTO"
      : formatInteger((ov.lamb_deaths || 0) + (ov.ewe_deaths || 0));
  const deathsNote =
    ov.lamb_deaths === null && ov.ewe_deaths === null
      ? null
      : `${formatInteger(ov.lamb_deaths || 0)} corderos · ${formatInteger(ov.ewe_deaths || 0)} oveja(s)`;

  // Jerarquía ejecutiva: lo que se mira primero, más grande.
  const kpis = [
    metricCard("Ovejas paridas", absentOr(ov.lambed_ewes, formatInteger), null, { kpi: true, accent: true }),
    metricCard("Corderos nacidos", absentOr(ov.born_lambs, formatInteger), null, { kpi: true, accent: true }),
    metricCard("Avance de parición", formatPercent(ov.progress_percent), "sobre previstas a parir", { kpi: true }),
    metricCard("Muertes registradas", deaths, deathsNote, { kpi: true }),
  ].join("");

  // Contexto secundario, tamaño reducido.
  const secondary = [
    metricCard("Previstas a parir", formatInteger(ov.expected_to_lamb)),
    metricCard("Corderos esperados", formatInteger(ov.expected_lambs)),
    metricCard("Nacidos vivos", absentOr(ov.born_alive, formatInteger)),
  ].join("");

  view.innerHTML = `
    <header class="view__head">
      <p class="eyebrow">Panorama general</p>
      <h1 id="title-resumen">Resumen de la campaña</h1>
      <p class="view__intro">Lo esencial de un vistazo. Cada lote tiene su vista específica en el menú.</p>
    </header>

    <div class="kpi-row">${kpis}</div>
    <div class="stat-grid">${secondary}</div>

    <section class="panel">
      <div class="panel__head">
        <div><p class="eyebrow">Por lote</p><h2>Los tres módulos</h2></div>
        <p>Tocá un lote para ver su detalle.</p>
      </div>
      <div class="lot-cards">${LOTS.map(distributionCard).join("")}</div>
    </section>

    <section class="panel" id="chill-general">
      <div class="panel__head">
        <div><p class="eyebrow">Chill Index</p><h2>Riesgo ambiental — próximos días</h2></div>
        <p>Corderos esperados expuestos a condiciones ambientales de riesgo durante sus primeras 72 horas.</p>
      </div>
      ${chillGeneral()}
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
  const nacidos = module ? absentOr(module.lamb_counts.counted, formatInteger) : "—";
  const muertos = module ? formatInteger(module.mortality.lamb_deaths_accumulated) : "—";
  const progress = module ? formatPercent(module.ewe_counts.progress_percent) : "—";
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
        ${cell("Avance", progress)}
      </dl>
      <span class="lot-card__state tag tag--${state === "ACTUALIZADO" ? "ok" : "pending"}">${escapeHtml(state)}</span>
    </a>`;
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

// Tarjeta de un día de Chill. `exposure` es la cifra a mostrar; `lots` es el
// desglose por lote (sólo en la vista general).
function chillDay(day, exposure, lots) {
  const cat = day.risk_category;
  const rel = dayRelative(day.date);
  const complete = day.cohort_72h_complete
    ? ""
    : `<span class="tag tag--incompleto">72 H INCOMPLETO</span>`;
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

/* Chill general: exposición diaria (con desglose por lote) y consolidado 72 h. */
function chillGeneral() {
  const chill = DASH.chill_public || {};
  const days = Array.isArray(chill.daily) ? chill.daily : [];
  const stale = chill.update_status && chill.update_status.stale;

  if (!days.length) {
    return `<p class="empty-note">SIN DISTRIBUCIÓN DE PARTOS CARGADA — el cálculo se habilita cuando exista curva de partos.</p>`;
  }

  const rows = days
    .map((day) => {
      const lots = LOTS.map(
        (lot) => `${LOT_SHORT[lot.code]} ${escapeHtml(formatExposure((day.by_lot || {})[lot.code]))}`,
      ).join(" · ");
      return chillDay(day, day.total_exposed, lots);
    })
    .join("");

  return `
    ${stale ? `<p class="tag tag--incompleto">El Chill Index no está actualizado.</p>` : ""}
    <p class="chill-mode">Exposición diaria — una cohorte puede aparecer en varios días.</p>
    <ul class="chill-list">${rows}</ul>
    ${chill72h(chill.exposure_72h, null)}
    <p class="chill-source">Fuente: INIA-GRAS · ${iniaLink()}</p>`;
}

/* Consolidado 72 h: cada cohorte una vez, por su riesgo máximo. lotCode filtra. */
function chill72h(exposure, lotCode) {
  if (!exposure || typeof exposure !== "object") return "";
  const scope = lotCode ? (exposure.by_module || {})[lotCode] || {} : exposure;
  const cells = [...RISK_ORDER, "RIESGO_72H_INCOMPLETO"]
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
      <p class="chill-mode">Consolidado 72 h — cada cohorte contada una sola vez, por su riesgo máximo.</p>
      <div class="expo-grid">${cells}</div>
    </div>`;
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
      <div class="panel__head"><h2>Indicadores productivos</h2></div>
      <div class="stat-grid">${lotIndicators(module)}</div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2>Curva de partos</h2><p>Esperada de origen, ajustada por recuento si existe, y evolución real.</p></div>
      ${lotCurve(lot, curve)}
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>Riesgo ambiental del lote</h2>
        <p>Corderos esperados expuestos a condiciones ambientales de riesgo durante sus primeras 72 horas.</p>
      </div>
      ${lotChill(lot.code)}
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

function lotIndicators(module) {
  const iv = module.initial_values;
  const ec = module.ewe_counts;
  const lc = module.lamb_counts;
  const mort = module.mortality;
  const remainingEwes = ec.counted_lambed !== null ? ec.expected_to_lamb - ec.counted_lambed : null;
  const remainingLambs = lc.counted !== null ? lc.expected_total - lc.counted : null;
  return [
    metricCard("Servidas", formatInteger(iv.served)),
    metricCard("Preñadas", formatInteger(iv.expected_to_lamb)),
    metricCard("Corderos esperados", formatInteger(iv.expected_lambs)),
    metricCard("Ovejas paridas", ec.counted_lambed === null ? "SIN RECUENTO" : formatInteger(ec.counted_lambed)),
    metricCard("Corderos nacidos", lc.counted === null ? "SIN RECUENTO" : formatInteger(lc.counted)),
    metricCard("Muertes de cordero", formatInteger(mort.lamb_deaths_accumulated)),
    metricCard("Muertes de oveja", formatInteger(mort.ewe_deaths_accumulated)),
    metricCard("Avance de parición", formatPercent(ec.progress_percent), "sobre previstas a parir"),
    metricCard("Ovejas restantes", remainingEwes === null ? "SIN RECUENTO" : formatInteger(remainingEwes)),
    metricCard("Corderos restantes", remainingLambs === null ? "SIN RECUENTO" : formatInteger(remainingLambs)),
  ].join("");
}

function lotCurve(lot, curve) {
  if (!curve || !(curve.expected_original || []).length) {
    return `<p class="empty-note">SIN CURVA CARGADA para este lote.</p>`;
  }
  const original = curve.expected_original || [];
  const adjusted = curve.expected_adjusted || [];
  const series = (adjusted.length ? adjusted : original).map((point, index) => ({
    date: point.date,
    ewes: point.expected_ewes || 0,
    lambs: point.expected_lambs || 0,
    cumulative: 0,
    _i: index,
  }));
  const totalEwes = series.reduce((s, p) => s + p.ewes, 0);
  let acc = 0;
  series.forEach((p) => {
    acc += p.ewes;
    p.cumulative = totalEwes > 0 ? acc / totalEwes : 0;
  });
  CURVE_SERIES[lot.code] = series;
  const kind = adjusted.length ? "Curva ajustada por recuento" : "Curva original";
  return `
    <div class="curve-controls">
      <span class="tag ${adjusted.length ? "tag--ok" : "tag--muted"}">${escapeHtml(kind)}</span>
      <span class="chart-note">Barras: ovejas y corderos previstos por día. Línea: acumulado.</span>
    </div>
    <div class="chart-wrap"><canvas id="curve-${escapeHtml(lot.code)}" role="img" aria-label="Curva de partos de ${escapeHtml(lot.name)}"></canvas></div>`;
}

function lotChill(code) {
  const chill = DASH.chill_public || {};
  const days = Array.isArray(chill.daily) ? chill.daily : [];
  if (!days.length) return `<p class="empty-note">SIN DISTRIBUCIÓN DE PARTOS CARGADA.</p>`;
  const rows = days.map((day) => chillDay(day, (day.by_lot || {})[code])).join("");
  return `
    <p class="chill-mode">Exposición diaria del lote.</p>
    <ul class="chill-list">${rows}</ul>
    ${chill72h(chill.exposure_72h, code)}
    <p class="chill-source">Fuente: INIA-GRAS · ${iniaLink()}</p>`;
}

function lotMortality(lot, module) {
  const mort = module.mortality;
  const detail = Array.isArray(mort.detail) ? mort.detail : [];
  const summary = `
    <div class="mort-summary">
      <div class="mort-tile"><span>Muertes de cordero</span><strong>${escapeHtml(formatInteger(mort.lamb_deaths_accumulated))}</strong></div>
      <div class="mort-tile"><span>Muertes de oveja</span><strong>${escapeHtml(formatInteger(mort.ewe_deaths_accumulated))}</strong></div>
      <div class="mort-tile"><span>Último parte</span><strong>${escapeHtml(formatDate(mort.last_report_date))}</strong></div>
    </div>`;

  if (!detail.length) {
    return `${summary}<p class="empty-note">SIN REGISTROS de mortalidad en este lote.</p>`;
  }

  const rows = detail
    .map((event) => {
      const auto = event.provenance === "AUTOMATICO_SIN_VALIDAR"
        ? `<span class="tag tag--auto">incorporado automáticamente</span>`
        : "";
      return `
        <tr>
          <td>${escapeHtml(formatDate(event.date))}</td>
          <td>${escapeHtml(event.animal === "OVEJA" ? "Oveja" : "Cordero")}</td>
          <td class="num">${escapeHtml(formatInteger(event.count))}</td>
          <td>${escapeHtml(event.cause_label)}</td>
          <td>${event.comment ? escapeHtml(event.comment) : "<span class='muted'>—</span>"} ${auto}</td>
        </tr>`;
    })
    .join("");

  return `
    ${summary}
    <details class="mort-drawer">
      <summary>Ver detalle de mortalidad (${detail.length})</summary>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Animal</th><th class="num">Cant.</th><th>Causa</th><th>Comentario</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="chart-note">Causas normalizadas. Sin causa informada: “Causa no determinada”; nunca se infiere por contexto.</p>
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
  const code = CODE_BY_SECTION[name];
  if (!code) return;
  const series = CURVE_SERIES[code];
  const canvas = byId(`curve-${code}`);
  if (series && canvas) drawCurveChart(canvas, series);
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
  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => drawSectionCharts(currentSection()));
  });
  showSection(currentSection());
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

/* ------------------------------------------------------------- gráfico --- */

function drawCurveChart(canvas, series) {
  const wrap = canvas.parentElement;
  if (!wrap || !series.length) return;
  const context = canvas.getContext("2d");
  const width = Math.max(280, Math.floor(wrap.clientWidth));
  const height = 300;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { top: 18, right: 46, bottom: 42, left: 46 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...series.map((item) => Math.max(item.ewes, item.lambs)), 1);
  const slot = plotWidth / series.length;
  const barWidth = Math.max(1.5, Math.min(10, slot * 0.38));

  context.strokeStyle = "rgba(135, 135, 134, 0.28)";
  context.lineWidth = 1;
  context.font = "11px Raleway, system-ui, sans-serif";
  context.fillStyle = "#878786";
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (plotHeight / 4) * step;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
    const value = (maxValue * (4 - step)) / 4;
    context.textAlign = "right";
    context.fillText(integerFormatter.format(Math.round(value)), padding.left - 6, y + 4);
    context.textAlign = "left";
    context.fillText(`${Math.round(((4 - step) / 4) * 100)}%`, padding.left + plotWidth + 8, y + 4);
  }

  series.forEach((item, index) => {
    const centre = padding.left + slot * index + slot / 2;
    const eweHeight = (item.ewes / maxValue) * plotHeight;
    const lambHeight = (item.lambs / maxValue) * plotHeight;
    context.fillStyle = "#006937";
    context.fillRect(centre - barWidth - 1, padding.top + plotHeight - eweHeight, barWidth, eweHeight);
    context.fillStyle = "#7fb69a";
    context.fillRect(centre + 1, padding.top + plotHeight - lambHeight, barWidth, lambHeight);
  });

  context.beginPath();
  context.strokeStyle = "#c8102e";
  context.lineWidth = 2;
  series.forEach((item, index) => {
    const centre = padding.left + slot * index + slot / 2;
    const y = padding.top + plotHeight - item.cumulative * plotHeight;
    if (index === 0) context.moveTo(centre, y);
    else context.lineTo(centre, y);
  });
  context.stroke();

  context.fillStyle = "#878786";
  context.textAlign = "center";
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  series.forEach((item, index) => {
    if (index % labelEvery !== 0 && index !== series.length - 1) return;
    const centre = padding.left + slot * index + slot / 2;
    context.fillText(formatDate(item.date, { short: true, includeYear: false }), centre, height - 14);
  });
}

boot();
