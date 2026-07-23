"use strict";

const DATA_URL = "./data/dashboard.json";
const SUPPORTED_SCHEMA = "3.0.0";
const state = { data: null };

const integerFormatter = new Intl.NumberFormat("es-UY", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("es-UY", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

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

function formatCoordinate(value) {
  return value === null || value === undefined ? "Pendiente" : Number(value).toFixed(7);
}

function assertDashboard(data) {
  const requiredObjects = [
    "campaign",
    "overview",
    "update_status",
    "initial_source",
    "automatic_provisional",
    "freshness_thresholds",
    "environmental_forecast",
  ];
  const requiredArrays = ["modules", "daily_evolution", "recent_records"];

  if (!data || typeof data !== "object") throw new Error("JSON inválido");
  if (data.schema_version !== SUPPORTED_SCHEMA) {
    throw new Error(`Versión de esquema no compatible: ${data.schema_version}`);
  }
  if (
    data.data_mode !== "OPERATIONAL" ||
    data.data_notice !== "INFORMACIÓN AUTOMÁTICA PROVISORIA — PENDIENTE DE REVISIÓN"
  ) {
    throw new Error("El tablero operativo no está identificado correctamente");
  }
  for (const field of requiredObjects) {
    if (!data[field] || typeof data[field] !== "object") {
      throw new Error(`Falta el objeto ${field}`);
    }
  }
  for (const field of requiredArrays) {
    if (!Array.isArray(data[field])) throw new Error(`Falta la lista ${field}`);
  }
  if (!Array.isArray(data.environmental_forecast.days)) {
    throw new Error("Falta la previsión ambiental diaria");
  }
}

function renderHeader(data) {
  byId("demo-notice").textContent = data.data_notice;
  byId("page-title").textContent = data.campaign.name;
  byId("mode-status").textContent = "Tablero operativo";
  byId("last-updated").textContent = formatDateTime(data.generated_at, data.timezone);

  const progress = data.overview.progress_percent;
  byId("progress-value").textContent = formatPercent(progress);
  byId("progress-ring").style.setProperty(
    "--progress",
    `${Math.max(0, Math.min(100, Number(progress) || 0)) * 3.6}deg`,
  );
  byId("progress-ring").setAttribute("aria-label", `Avance de parición: ${formatPercent(progress)}`);
  byId("lambed-highlight").textContent = formatInteger(data.overview.lambed_ewes);
  byId("expected-highlight").textContent = formatInteger(data.overview.expected_to_lamb);
  byId("alive-highlight").textContent = formatInteger(data.overview.born_alive);
  byId("processing-highlight").textContent = friendlyStatus(data.update_status.last_zip?.status);
}

function renderMetrics(overview) {
  const metrics = [
    {
      key: "served_ewes",
      label: "Ovejas encarneradas",
      note: "Fuente inicial vigente",
      tone: "",
    },
    {
      key: "expected_to_lamb",
      label: "Hembras previstas a parir",
      note: "Ecografía resumida vigente",
      tone: "",
    },
    {
      key: "lambed_ewes",
      label: "Ovejas paridas",
      note: "Último recuento confirmado",
      tone: "positive",
    },
    {
      key: "progress_percent",
      label: "Porcentaje de avance",
      note: "Paridas sobre previstas",
      tone: "positive",
      percent: true,
    },
    {
      key: "born_lambs",
      label: "Corderos nacidos",
      note: "Recuento confirmado",
      tone: "",
    },
    {
      key: "born_alive",
      label: "Corderos vivos",
      note: "Recuento confirmado",
      tone: "positive",
    },
    {
      key: "stillborn",
      label: "Muertos al nacimiento",
      note: "Registro confirmado",
      tone: "attention",
    },
    {
      key: "ewe_deaths",
      label: "Muertes de ovejas",
      note: "Registro confirmado",
      tone: "attention",
    },
    {
      key: "deaths_last_24h",
      label: "Muertes en últimas 24 h",
      note: "Sin completar ausencias con cero",
      tone: "attention",
    },
    {
      key: "expected_lambs",
      label: "Corderos esperados",
      note: "Fuente inicial vigente",
      tone: "",
    },
  ];

  byId("metric-grid").innerHTML = metrics
    .map((metric) => {
      const raw = overview[metric.key];
      const display = metric.percent ? formatPercent(raw) : formatInteger(raw);
      const tone = metric.tone ? ` metric-card--${metric.tone}` : "";
      return `
        <article class="metric-card${tone}">
          <span class="metric-card__label">${escapeHtml(metric.label)}</span>
          <strong class="metric-card__value">${escapeHtml(display)}</strong>
          <span class="metric-card__note">${escapeHtml(metric.note)}</span>
        </article>`;
    })
    .join("");
}

function daysSince(dateString, referenceIso) {
  if (!dateString || !referenceIso) return null;
  const source = dateString.slice(0, 10).split("-").map(Number);
  const reference = referenceIso.slice(0, 10).split("-").map(Number);
  if (source.some(Number.isNaN) || reference.some(Number.isNaN)) return null;
  const sourceUtc = Date.UTC(source[0], source[1] - 1, source[2]);
  const referenceUtc = Date.UTC(reference[0], reference[1] - 1, reference[2]);
  return Math.max(0, Math.floor((referenceUtc - sourceUtc) / 86_400_000));
}

function ageCopy(ageDays) {
  if (ageDays === null) return "antigüedad no disponible";
  if (ageDays === 0) return "hoy";
  if (ageDays === 1) return "hace 1 día";
  return `hace ${ageDays} días`;
}

function freshnessState(dateString, thresholds, referenceIso) {
  const ageDays = daysSince(dateString, referenceIso);
  if (ageDays === null || ageDays > Number(thresholds.aged_max_days)) {
    return { key: "stale", label: "SIN RECUENTO RECIENTE", ageDays };
  }
  if (ageDays <= Number(thresholds.updated_max_days)) {
    return { key: "updated", label: "ACTUALIZADO", ageDays };
  }
  return { key: "aged", label: "RECUENTO CON ANTIGÜEDAD", ageDays };
}

function freshnessBadge(status) {
  return `<span class="freshness-badge freshness-badge--${escapeHtml(status.key)}">${escapeHtml(
    status.label,
  )}</span>`;
}

function progressBlock({ title, valueCopy, progress, dateLabel, status, note }) {
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  return `
    <section class="count-block">
      <div class="count-block__heading">
        <div>
          <span class="count-block__title">${escapeHtml(title)}</span>
          <strong>${escapeHtml(valueCopy)}</strong>
        </div>
        <strong class="count-block__percent">${escapeHtml(formatPercent(progress))}</strong>
      </div>
      <div
        class="count-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${safeProgress}"
        aria-label="${escapeHtml(title)}: ${escapeHtml(formatPercent(progress))}"
      >
        <span style="--count-progress: ${safeProgress}%"></span>
      </div>
      <div class="count-block__footer">
        <span>${escapeHtml(dateLabel)}</span>
        ${freshnessBadge(status)}
      </div>
      ${note ? `<p class="count-block__note">${escapeHtml(note)}</p>` : ""}
    </section>`;
}

function renderModules(modules, thresholds, generatedAt) {
  byId("module-grid").innerHTML = modules
    .map((module) => {
      const ewes = module.ewe_counts;
      const lambs = module.lamb_counts;
      const mortality = module.mortality;
      const initial = module.initial_values;
      const eweStatus = freshnessState(ewes.last_count_date, thresholds.counts, generatedAt);
      const lambStatus = freshnessState(lambs.last_count_date, thresholds.counts, generatedAt);
      const mortalityStatus = freshnessState(
        mortality.last_report_date,
        thresholds.mortality,
        generatedAt,
      );

      return `
        <article class="module-card">
          <header class="module-card__header">
            <span class="module-card__code">${escapeHtml(module.code)}</span>
            <h3>${escapeHtml(module.name)}</h3>
          </header>
          <div class="module-card__body">
            <section class="initial-baseline" aria-label="Valores iniciales del Excel vigente">
              <div class="initial-baseline__heading">
                <span>FUENTE EXCEL VIGENTE</span>
                <strong>Valores esperados</strong>
              </div>
              <dl>
                <div><dt>Encarneradas</dt><dd>${escapeHtml(formatInteger(initial.served))}</dd></div>
                <div><dt>Previstas a parir</dt><dd>${escapeHtml(
                  formatInteger(initial.expected_to_lamb),
                )}</dd></div>
                <div><dt>Corderos esperados</dt><dd>${escapeHtml(
                  formatInteger(initial.expected_lambs),
                )}</dd></div>
                <div><dt>Muertes previas a ECO</dt><dd>${escapeHtml(
                  formatInteger(initial.deaths_between_served_and_scan),
                )}</dd></div>
              </dl>
            </section>
            ${progressBlock({
              title: "Ovejas · último valor observado",
              valueCopy: `${formatInteger(ewes.counted_lambed)} de ${formatInteger(
                ewes.expected_to_lamb,
              )} ovejas paridas`,
              progress: ewes.progress_percent,
              dateLabel: `Último recuento: ${formatDate(ewes.last_count_date)} · ${ageCopy(
                eweStatus.ageDays,
              )}`,
              status: eweStatus,
            })}
            ${progressBlock({
              title: "Corderos · último valor observado",
              valueCopy: `${formatInteger(lambs.counted)} de ${formatInteger(
                lambs.expected_total,
              )} corderos esperados contabilizados`,
              progress: lambs.progress_percent,
              dateLabel: `Último recuento: ${formatDate(lambs.last_count_date)} · ${ageCopy(
                lambStatus.ageDays,
              )}`,
              status: lambStatus,
              note: "El recuento no equivale automáticamente a corderos nacidos.",
            })}
            <section class="mortality-block">
              <div class="mortality-block__heading">
                <div>
                  <span class="count-block__title">Mortalidad</span>
                  <strong>Acumulado y últimas 24 horas</strong>
                </div>
                ${freshnessBadge(mortalityStatus)}
              </div>
              <dl class="mortality-stats">
                ${mortalityStat("Corderos acumulados", mortality.lamb_deaths_accumulated)}
                ${mortalityStat("Ovejas acumuladas", mortality.ewe_deaths_accumulated)}
                ${mortalityStat("Muertes últimas 24 h", mortality.deaths_last_24h)}
              </dl>
              <p>Último parte: ${escapeHtml(formatDate(mortality.last_report_date))} · ${escapeHtml(
                ageCopy(mortalityStatus.ageDays),
              )}</p>
            </section>
          </div>
        </article>`;
    })
    .join("");
}

function mortalityStat(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(formatInteger(value))}</dd>
    </div>`;
}

function eventTone(type) {
  return ["LAMB_DEATH", "EWE_DEATH"].includes(type) ? " event-tag--attention" : "";
}

function renderRecords(records) {
  byId("record-count").textContent = String(records.length);
  byId("record-count").setAttribute("aria-label", `${records.length} registros recientes`);

  byId("records-body").innerHTML = records
    .map(
      (record) => `
        <tr>
          <td>${escapeHtml(formatDate(record.date))}</td>
          <td><span class="module-tag">${escapeHtml(record.module_code)}</span></td>
          <td><span class="event-tag${eventTone(record.event_type)}">${escapeHtml(
            record.event_label,
          )}</span></td>
          <td><strong>${escapeHtml(formatInteger(record.quantity))}</strong></td>
          <td>${escapeHtml(record.observation)}</td>
        </tr>`,
    )
    .join("");

  byId("record-cards").innerHTML = records
    .map(
      (record) => `
        <article class="record-card">
          <div class="record-card__top">
            <span class="module-tag">${escapeHtml(record.module_code)}</span>
            <span class="record-card__date">${escapeHtml(formatDate(record.date))}</span>
          </div>
          <div class="record-card__event">
            <strong>${escapeHtml(record.event_label)}</strong>
            <span class="record-card__quantity">${escapeHtml(formatInteger(record.quantity))}</span>
          </div>
          <p>${escapeHtml(record.observation)}</p>
        </article>`,
    )
    .join("");
}

function riskClass(category) {
  const accepted = ["SIN_RIESGO", "BAJO", "MEDIO", "ALTO", "CRITICO"];
  return accepted.includes(category) ? category.toLowerCase().replace("_", "-") : "unknown";
}

function riskLabel(category) {
  return category === "SIN_RIESGO" ? "SIN RIESGO" : category || "NO INFORMADO";
}

function renderForecast(forecast, timezone) {
  const source = forecast.source;
  const location = forecast.location;
  const grid = forecast.grid_point;
  byId("official-link").href = source.official_url;
  const distance =
    grid.distance_km === null || grid.distance_km === undefined
      ? "Pendiente de validar"
      : `${formatDecimal(grid.distance_km)} km`;

  byId("forecast-metadata").innerHTML = `
    <article>
      <span>Ubicación</span>
      <strong>${escapeHtml(location.name)}</strong>
      <small>${escapeHtml(formatCoordinate(location.latitude))}, ${escapeHtml(
        formatCoordinate(location.longitude),
      )}</small>
    </article>
    <article>
      <span>Punto de grilla</span>
      <strong>${escapeHtml(distance)}</strong>
      <small>Resolución publicada: ${escapeHtml(formatInteger(source.spatial_resolution_km))} km</small>
    </article>
    <article>
      <span>Pronóstico generado</span>
      <strong>${escapeHtml(formatDateTime(forecast.forecast_generated_at, timezone))}</strong>
      <small>Consultado ${escapeHtml(formatDateTime(forecast.queried_at, timezone))}</small>
    </article>
    <article>
      <span>Método de agregación</span>
      <strong>${escapeHtml(forecast.aggregation_method)}</strong>
      <small>${escapeHtml(source.model)} · ${escapeHtml(forecast.period_type)}</small>
    </article>`;

  byId("forecast-grid").innerHTML = forecast.days
    .map((day) => {
      const tone = riskClass(day.risk_category);
      const moduleRows = day.modules
        .map(
          (module) => `
            <li>
              <strong>${escapeHtml(module.code)}</strong>
              <span>${escapeHtml(formatInteger(module.expected_lambings))} partos</span>
              <span>${escapeHtml(formatInteger(module.expected_lambs))} corderos</span>
            </li>`,
        )
        .join("");
      return `
        <article class="forecast-card forecast-card--${escapeHtml(tone)}">
          <header>
            <div>
              <span>${escapeHtml(formatDate(day.date, { short: true }))}</span>
              <small>${escapeHtml(day.period)}</small>
            </div>
            <span class="risk-badge risk-badge--${escapeHtml(tone)}">${escapeHtml(
              riskLabel(day.risk_category),
            )}</span>
          </header>
          <div class="chill-value">
            <strong>${escapeHtml(formatInteger(day.chill_index))}</strong>
            <span>${escapeHtml(forecast.unit)}</span>
          </div>
          <dl class="forecast-totals">
            <div>
              <dt>Partos esperados</dt>
              <dd>${escapeHtml(formatInteger(day.expected_lambings))}</dd>
            </div>
            <div>
              <dt>Corderos esperados</dt>
              <dd>${escapeHtml(formatInteger(day.expected_lambs))}</dd>
            </div>
            <div>
              <dt>Expuestos primeras 72 h</dt>
              <dd>${escapeHtml(formatInteger(day.lambs_exposed_first_72h))}</dd>
            </div>
          </dl>
          <details>
            <summary>Desglose por módulo</summary>
            <ul>${moduleRows}</ul>
          </details>
        </article>`;
    })
    .join("");
}

function friendlyStatus(status) {
  const labels = {
    COMPLETADO_DEMO: "Completado · demo",
    COMPLETADO: "Completado",
    COMPLETADO_CON_ADVERTENCIAS: "Completado con avisos",
    YA_PROCESADO: "Ya procesado",
    COMPLETED: "Completado",
    COMPLETED_WITH_WARNINGS: "Completado con avisos",
    FAILED: "Con error",
    PENDING: "Pendiente",
  };
  return labels[status] || status || "—";
}

function renderUpdateStatus(data) {
  const update = data.update_status;
  const zip = update.last_zip || {};
  byId("last-zip").textContent = zip.name || "—";
  byId("last-processing").textContent = `${friendlyStatus(zip.status)} · ${formatDateTime(
    zip.processed_at,
    data.timezone,
  )}`;
  byId("last-sync").textContent = formatDateTime(update.last_sync_at, data.timezone);
  byId("pending-operations").textContent = formatInteger(update.pending_operations);
  byId("initial-source").textContent = data.initial_source?.file || "—";
  const sourceHash = data.initial_source?.sha256;
  byId("initial-source-hash").textContent = sourceHash
    ? `${sourceHash.slice(0, 16)}…`
    : "—";
  byId("initial-source-hash").title = sourceHash || "";
  byId("initial-source-date").textContent = formatDateTime(
    data.initial_source?.imported_at,
    data.timezone,
  );
  byId("update-message").textContent = update.public_message || "—";
  byId("provisional-message").textContent = data.automatic_provisional?.notice || "—";
  updateFreshness(data);
}

function updateFreshness(data) {
  const freshness = byId("freshness");
  const label = byId("freshness-label");
  const detail = byId("freshness-detail");
  const lastSync = data.update_status.last_sync_at;
  freshness.classList.remove("is-fresh", "is-stale");

  if (!lastSync) {
    freshness.classList.add("is-stale");
    label.textContent = "Sin sincronización informada";
    detail.textContent = "No existe una fecha disponible";
    return;
  }

  const elapsedHours = Math.max(0, (Date.now() - new Date(lastSync).getTime()) / 3_600_000);
  const threshold = Number(data.stale_after_hours) || 12;
  const rounded = elapsedHours < 1 ? "menos de una hora" : `${Math.floor(elapsedHours)} h`;

  if (elapsedHours <= threshold) {
    freshness.classList.add("is-fresh");
    label.textContent = "Datos actualizados";
    detail.textContent = `Última sincronización hace ${rounded}`;
  } else {
    freshness.classList.add("is-stale");
    label.textContent = "Datos desactualizados";
    detail.textContent = `Sin novedades hace ${rounded}`;
  }
}

function drawEvolutionChart(series) {
  const canvas = byId("evolution-chart");
  const wrap = canvas.parentElement;
  if (!wrap || !series.length) return;

  const width = Math.max(280, Math.floor(wrap.clientWidth));
  const height = Math.max(240, Math.floor(wrap.clientHeight));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const css = getComputedStyle(document.documentElement);
  const colors = {
    green: css.getPropertyValue("--sul-green").trim(),
    greenLight: css.getPropertyValue("--sul-green-light").trim(),
    gray: css.getPropertyValue("--institutional-gray").trim(),
    ink: css.getPropertyValue("--ink-600").trim(),
    grid: "rgba(38, 56, 49, 0.12)",
  };
  const padding = { top: 22, right: 48, bottom: 45, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const dailyMax = Math.max(...series.flatMap((item) => [item.lambed_ewes || 0, item.born_lambs || 0]), 1);
  const cumulativeMax = Math.max(...series.map((item) => item.cumulative_lambed || 0), 1);
  const dailyScale = Math.ceil(dailyMax / 10) * 10;
  const groupWidth = chartWidth / series.length;
  const barWidth = Math.min(18, Math.max(8, groupWidth * 0.22));

  context.font = '11px "Raleway", "Segoe UI", Arial, sans-serif';
  context.lineWidth = 1;
  context.textBaseline = "middle";

  for (let step = 0; step <= 4; step += 1) {
    const ratioStep = step / 4;
    const y = padding.top + chartHeight - chartHeight * ratioStep;
    context.strokeStyle = colors.grid;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = colors.ink;
    context.textAlign = "right";
    context.fillText(String(Math.round(dailyScale * ratioStep)), padding.left - 9, y);
    context.textAlign = "left";
    context.fillText(String(Math.round(cumulativeMax * ratioStep)), width - padding.right + 9, y);
  }

  series.forEach((item, index) => {
    const centerX = padding.left + groupWidth * index + groupWidth / 2;
    const eweHeight = ((item.lambed_ewes || 0) / dailyScale) * chartHeight;
    const lambHeight = ((item.born_lambs || 0) / dailyScale) * chartHeight;
    roundedBar(
      context,
      centerX - barWidth - 2,
      padding.top + chartHeight - eweHeight,
      barWidth,
      eweHeight,
      4,
      colors.green,
    );
    roundedBar(
      context,
      centerX + 2,
      padding.top + chartHeight - lambHeight,
      barWidth,
      lambHeight,
      4,
      colors.greenLight,
    );

    context.fillStyle = colors.ink;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(formatDate(item.date, { short: true, includeYear: false }), centerX, height - padding.bottom + 14);
    context.textBaseline = "middle";
  });

  context.strokeStyle = colors.gray;
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  series.forEach((item, index) => {
    const x = padding.left + groupWidth * index + groupWidth / 2;
    const y = padding.top + chartHeight - ((item.cumulative_lambed || 0) / cumulativeMax) * chartHeight;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  series.forEach((item, index) => {
    const x = padding.left + groupWidth * index + groupWidth / 2;
    const y = padding.top + chartHeight - ((item.cumulative_lambed || 0) / cumulativeMax) * chartHeight;
    context.fillStyle = "#ffffff";
    context.strokeStyle = colors.gray;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });
}

function roundedBar(context, x, y, width, height, radius, color) {
  const safeHeight = Math.max(0, height);
  const safeRadius = Math.min(radius, width / 2, safeHeight / 2);
  context.fillStyle = color;
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, safeHeight, [safeRadius, safeRadius, 0, 0]);
  } else {
    context.rect(x, y, width, safeHeight);
  }
  context.fill();
}

function initializeNavigation() {
  const links = [...document.querySelectorAll(".main-nav__link")];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((link) => {
        link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`);
      });
    },
    { rootMargin: "-25% 0px -60%", threshold: [0.05, 0.2, 0.5] },
  );
  sections.forEach((section) => observer.observe(section));
}

function renderDashboard(data) {
  renderHeader(data);
  renderMetrics(data.overview);
  renderModules(data.modules, data.freshness_thresholds, data.generated_at);
  renderForecast(data.environmental_forecast, data.timezone);
  renderRecords(data.recent_records);
  renderUpdateStatus(data);
  drawEvolutionChart(data.daily_evolution);

  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => drawEvolutionChart(data.daily_evolution));
  });
  window.setInterval(() => updateFreshness(data), 60_000);
}

async function loadDashboard() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    assertDashboard(data);
    state.data = data;
    renderDashboard(data);
    initializeNavigation();
  } catch (error) {
    console.error("No se pudo cargar el dashboard operativo", error);
    byId("load-error").hidden = false;
  }
}

loadDashboard();
