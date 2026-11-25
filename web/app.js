const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const colors = ["#1f2937", "#0f766e", "#b45309", "#1d4ed8", "#9f1239"];
const storageKey = "portfolio-compare-mixes-v2";
const settingsKey = "portfolio-compare-settings";
const mixes = [];
const pad = 28;

function pct(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function normalize(weights) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) throw new Error("至少選一檔，權重要大於 0");
  return Object.fromEntries(entries.map(([symbol, weight]) => [symbol, weight / total]));
}

function returnsFromSeries(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const [month, price] = series[i];
    const prev = series[i - 1][1];
    if (prev > 0 && price > 0) out.push([month, price / prev - 1]);
  }
  return out;
}

function selectedRange() {
  const preset = document.querySelector("#window .is-on").dataset.years;
  const end = document.querySelector("#to").value || document.querySelector("#updated").dataset.end || "";
  if (preset === "custom") return [document.querySelector("#from").value, end];
  if (!preset || preset === "0" || !end) return ["", end];
  const [year, month] = end.split("-").map(Number);
  const start = new Date(Date.UTC(year - Number(preset), month - 1, 1));
  return [start.toISOString().slice(0, 7), end];
}

function overlap(selected, series) {
  const maps = selected.map((symbol) => new Map(returnsFromSeries(series[symbol])));
  const [start, end] = selectedRange();
  const months = [...maps[0].keys()].filter((month) => month >= start && (!end || month <= end) && maps.every((item) => item.has(month)));
  months.sort();
  return months.map((month) => [month, selected.map((symbol, index) => maps[index].get(month))]);
}

function shouldReset(month, previous, frequency) {
  if (frequency === "none") return previous == null;
  if (frequency === "month") return true;
  if (frequency === "quarter") {
    const quarter = Math.floor((Number(month.slice(5)) - 1) / 3);
    const previousQuarter = previous ? Math.floor((Number(previous.slice(5)) - 1) / 3) : null;
    return previous == null || previous.slice(0, 4) !== month.slice(0, 4) || previousQuarter !== quarter;
  }
  return previous == null || previous.slice(0, 4) !== month.slice(0, 4);
}

function portfolioReturns(rows, symbols, weights, frequency = document.querySelector("#rebalance").value) {
  const target = normalize(weights);
  const order = symbols.map((symbol) => target[symbol]);
  let held = order.slice();
  let previous = null;
  return rows.map(([month, assetReturns]) => {
    if (shouldReset(month, previous, frequency)) held = order.slice();
    previous = month;
    const portfolio = held.reduce((sum, weight, index) => sum + weight * assetReturns[index], 0);
    const grown = held.map((weight, index) => weight * (1 + assetReturns[index]));
    const total = grown.reduce((sum, value) => sum + value, 0);
    held = grown.map((value) => value / total);
    return [month, portfolio];
  });
}

function monthlyAmount() {
  const amount = Number(document.querySelector("#amount").value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("每月金額要大於 0");
  return amount;
}

function dcaValue(rows, monthly = 10000) {
  let shares = 0;
  let contributed = 0;
  return rows.map(([month, value]) => {
    shares = (shares + monthly) * (1 + value);
    contributed += monthly;
    return [month, shares, contributed];
  });
}

function summarize(rows) {
  let growth = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const values = [];
  rows.forEach(([, value]) => {
    growth *= 1 + value;
    peak = Math.max(peak, growth);
    maxDrawdown = Math.min(maxDrawdown, growth / peak - 1);
    values.push(value);
  });
  const years = rows.length / 12;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length - 1, 1);
  return {
    start: rows[0][0],
    end: rows[rows.length - 1][0],
    cagr: growth ** (1 / years) - 1,
    volatility: Math.sqrt(variance * 12),
    maxDrawdown,
    final: null,
  };
}

function drawdownSeries(rows) {
  let growth = 1;
  let peak = 1;
  return rows.map(([month, value]) => {
    growth *= 1 + value;
    peak = Math.max(peak, growth);
    return [month, growth / peak - 1];
  });
}

function rollingCagr(rows, years = 5) {
  const width = years * 12;
  const out = [];
  for (let index = width; index <= rows.length; index += 1) {
    const slice = rows.slice(index - width, index);
    const growth = slice.reduce((product, [, value]) => product * (1 + value), 1);
    out.push([rows[index - 1][0], growth ** (1 / years) - 1]);
  }
  return out;
}

function annualRows(rows) {
  const grouped = new Map();
  rows.forEach(([month, value]) => {
    const year = month.slice(0, 4);
    grouped.set(year, [...(grouped.get(year) || []), value]);
  });
  return [...grouped.entries()].map(([year, values]) => ({
    year,
    total: values.reduce((product, value) => product * (1 + value), 1) - 1,
    partial: values.length < 12,
  }));
}

function label(weights) {
  return Object.entries(weights)
    .map(([symbol, weight]) => `${symbol.replace(".TW", "").replace(".TWO", "")} ${Math.round(weight * 100)}`)
    .join(" / ");
}

function selectedWeights() {
  const weights = {};
  document.querySelectorAll(".pick").forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    if (!box.checked) return;
    weights[box.value] = Number(row.querySelector(".weight").value);
  });
  return weights;
}

function renderPicker(data) {
  const picker = document.querySelector("#picker");
  data.symbols.forEach((item) => {
    const row = document.createElement("label");
    row.className = "pick";
    row.dataset.find = `${item.symbol} ${item.name}`.toLowerCase();
    row.innerHTML = `
      <input type="checkbox" value="${item.symbol}">
      <span><strong>${item.symbol}</strong><small>${item.name}</small></span>
      <input class="weight" type="number" min="0" max="100" value="50" disabled>
    `;
    const box = row.querySelector('input[type="checkbox"]');
    const weight = row.querySelector(".weight");
    box.addEventListener("change", () => { weight.disabled = !box.checked; });
    picker.appendChild(row);
  });
  document.querySelector("#filter").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll(".pick").forEach((row) => {
      row.classList.toggle("is-hidden", query !== "" && !row.dataset.find.includes(query));
    });
  });
}

function saveSettings() {
  localStorage.setItem(settingsKey, JSON.stringify({
    amount: document.querySelector("#amount").value,
    dca: document.querySelector("#dca").checked,
    benchAmount: document.querySelector("#bench-amount").value,
    benchDca: document.querySelector("#bench-dca").checked,
    rebalance: document.querySelector("#rebalance").value,
    years: document.querySelector("#window .is-on").dataset.years,
    from: document.querySelector("#from").value,
    to: document.querySelector("#to").value,
  }));
}

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(settingsKey) || "null");
  if (!saved) return;
  document.querySelector("#amount").value = saved.amount ?? document.querySelector("#amount").value;
  document.querySelector("#dca").checked = Boolean(saved.dca);
  document.querySelector("#bench-amount").value = saved.benchAmount ?? document.querySelector("#bench-amount").value;
  document.querySelector("#bench-dca").checked = Boolean(saved.benchDca);
  document.querySelector("#rebalance").value = saved.rebalance || document.querySelector("#rebalance").value;
  document.querySelector("#from").value = saved.from || "";
  document.querySelector("#to").value = saved.to || "";
  document.querySelectorAll("#window button").forEach((item) => {
    const on = item.dataset.years === (saved.years || "0");
    item.classList.toggle("is-on", on);
    item.setAttribute("aria-pressed", String(on));
  });
  document.querySelector(".dates").hidden = saved.years !== "custom";
}

function saveMixes() {
  const saved = mixes.filter((mix) => !mix.benchmark).map(({ weights, dca, monthly }) => ({ weights, dca, monthly }));
  localStorage.setItem(storageKey, JSON.stringify(saved));
}

function rebuildMixes(data) {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  mixes.splice(0);
  saved.forEach((mix) => addMix(data, mix.weights, Boolean(mix.dca), false, mix.monthly));
  ensureBenchmark(data);
  if (!mixes.length && saved.length) document.querySelector("#note").textContent = "這個區間裡，已存的組合沒有足夠月份";
}

function ensureBenchmark(data) {
  const kept = mixes.filter((mix) => !mix.benchmark);
  mixes.splice(0, mixes.length, ...kept);
  const lead = kept[0];
  if (!lead) return;
  const dca = document.querySelector("#bench-dca").checked;
  const monthly = Number(document.querySelector("#bench-amount").value);
  if (!Number.isFinite(monthly) || monthly <= 0) return;
  const sameMonths = (rows) => rows.filter(([month]) => lead.rows.some(([item]) => item === month));
  const rows = sameMonths(portfolioReturns(
    overlap(["0050.TW"], data.series),
    ["0050.TW"],
    { "0050.TW": 1 },
    "none",
  ));
  if (rows.length < 2) return;
  mixes.push({
    name: `基準 0050${dca ? ` · 定額 ${money.format(monthly)}` : ` · ${money.format(monthly)}`}`,
    weights: { "0050.TW": 1 },
    benchmark: true,
    dca,
    monthly,
    rows,
    curve: dca ? dcaValue(rows, monthly) : null,
    summary: summarize(rows),
    color: "#9ca3af",
  });
}

function addMix(data, weights, dca = document.querySelector("#dca").checked, persist = true, monthly = monthlyAmount(), benchmark = false) {
  const note = document.querySelector("#note");
  try {
    const clean = normalize(weights);
    const symbols = Object.keys(clean);
    const rows = portfolioReturns(overlap(symbols, data.series), symbols, clean);
    if (rows.length < 2) throw new Error("重疊月份不夠");
    if (mixes.filter((mix) => !mix.benchmark).length >= colors.length && !benchmark) throw new Error("最多五組");
    mixes.push({
      name: (benchmark ? "基準 " : "") + label(clean) + (dca ? ` · 定額 ${money.format(monthly)}` : ""),
      weights: clean,
      benchmark,
      dca,
      monthly,
      rows,
      curve: dca ? dcaValue(rows, monthly) : null,
      summary: summarize(rows),
      color: benchmark ? "#9ca3af" : colors[mixes.filter((item) => !item.benchmark).length],
    });
    note.textContent = "";
    if (persist) saveMixes();
    draw();
  } catch (error) {
    note.textContent = error.message;
  }
}

function lineSeries(rows, mode) {
  if (mode === "drawdown") return new Map(drawdownSeries(rows));
  if (mode === "rolling") return new Map(rollingCagr(rows));
  return curveOf({ rows, monthly: 1, dca: false });
}

function curveOf(mix) {
  let growth = mix.monthly;
  const values = mix.dca
    ? mix.curve.map(([, value]) => value)
    : mix.rows.map(([, value]) => {
      growth *= 1 + value;
      return growth;
    });
  return new Map(mix.rows.map(([month], index) => [month, values[index]]));
}

function monthIndex(month) {
  const [year, part] = month.split("-").map(Number);
  return year * 12 + part;
}

function chartMode() {
  return document.querySelector("#chart-mode .is-on").dataset.mode;
}

function shownMixes() {
  return chartMode() === "rolling" ? mixes.filter((mix) => !mix.benchmark) : mixes;
}

function scales() {
  const mode = chartMode();
  const curves = shownMixes().map((mix) => (mode === "value" ? curveOf(mix) : lineSeries(mix.rows, mode)));
  const months = [...new Set(curves.flatMap((curve) => [...curve.keys()]))].sort();
  const flat = curves.flatMap((curve) => [...curve.values()]);
  if (!flat.length) return { curves, months, min: 0, max: 1 };
  return {
    curves,
    months,
    min: Math.min(...flat),
    max: Math.max(...flat),
  };
}

function pointAt(month, value, scale) {
  const canvas = document.querySelector("#chart");
  const start = monthIndex(scale.months[0]);
  const span = Math.max(monthIndex(scale.months.at(-1)) - start, 1);
  const x = pad + ((monthIndex(month) - start) / span) * (canvas.width - pad * 2);
  const y = pad + (1 - (value - scale.min) / Math.max(scale.max - scale.min, 1)) * (canvas.height - pad * 2);
  return [x, y];
}

function draw() {
  const canvas = document.querySelector("#chart");
  const ctx = canvas.getContext("2d");
  const scale = scales();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath();
  ctx.moveTo(pad, canvas.height - pad);
  ctx.lineTo(canvas.width - pad, canvas.height - pad);
  ctx.stroke();
  ctx.fillStyle = "#6b7280";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  const years = [...new Set(scale.months.map((month) => month.slice(0, 4)))];
  let lastLabel = -Infinity;
  years.forEach((year) => {
    const month = scale.months.find((item) => item.startsWith(year));
    const x = pointAt(month, scale.min, scale)[0];
    if (x - lastLabel < 36 || x > canvas.width - pad) return;
    lastLabel = x;
    ctx.fillText(year, x, canvas.height - 8);
  });
  scale.curves.forEach((curve, index) => {
    ctx.strokeStyle = shownMixes()[index].color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    scale.months.forEach((month) => {
      if (!curve.has(month)) return;
      const [x, y] = pointAt(month, curve.get(month), scale);
      if (!started) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      started = true;
    });
    ctx.stroke();
  });
  renderTables();
}

function hoverAt(event) {
  const box = document.querySelector("#hover");
  if (!mixes.length || !scales().months.length) return;
  const canvas = document.querySelector("#chart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const scale = scales();
  const start = monthIndex(scale.months[0]);
  const span = Math.max(monthIndex(scale.months.at(-1)) - start, 1);
  const hovered = Math.round(start + ((x - pad) / (canvas.width - pad * 2)) * span);
  const month = scale.months.reduce((best, item) => (
    Math.abs(monthIndex(item) - hovered) < Math.abs(monthIndex(best) - hovered) ? item : best
  ));
  draw();
  const ctx = canvas.getContext("2d");
  const lineX = pointAt(month, scale.min, scale)[0];
  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(lineX, pad);
  ctx.lineTo(lineX, canvas.height - pad);
  ctx.stroke();
  const visible = shownMixes();
  const rows = visible.map((mix, mixIndex) => {
    const value = scale.curves[mixIndex].get(month);
    if (value == null) return `<div style="color:${mix.color}">${month} ${mix.name} —</div>`;
    const text = chartMode() === "value"
      ? `${money.format(value)} · ${pct(value / (mix.dca ? mix.curve.find(([item]) => item === month)[2] : mix.monthly) - 1)}`
      : pct(value);
    return `<div style="color:${mix.color}">${month} ${mix.name}<br>${text}</div>`;
  });
  box.hidden = false;
  box.innerHTML = rows.join("");
}

function renderTables() {
  document.querySelector("#legend").innerHTML = mixes.map((mix, index) =>
    `<span><i class="swatch" style="background:${mix.color}"></i>${mix.name}${mix.benchmark ? "" : `<button class="remove" data-index="${index}" type="button">移除</button>`}</span>`
  ).join("");
  document.querySelectorAll(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      mixes.splice(Number(button.dataset.index), 1);
      mixes.forEach((mix, index) => { mix.color = colors[index]; });
      saveMixes();
      draw();
    });
  });
  document.querySelector("#stats").innerHTML = mixes.map((mix) => `
    <tr>
      <td>${mix.name}</td>
      <td>${mix.summary.start}–${mix.summary.end}</td>
      <td>${pct(mix.summary.cagr)}</td>
      <td>${pct(mix.summary.volatility)}</td>
      <td class="down">${pct(mix.summary.maxDrawdown)}</td>
      <td>${money.format(mix.dca ? mix.curve.at(-1)[1] : mix.monthly * mix.rows.reduce((growth, [, value]) => growth * (1 + value), 1))}</td>
    </tr>
  `).join("");
  const years = [...new Set(mixes.flatMap((mix) => annualRows(mix.rows).map((row) => row.year)))].sort();
  document.querySelector("#year-head").innerHTML = `<th>年度</th>${mixes.map((mix) => `<th>${mix.name}</th>`).join("")}`;
  document.querySelector("#years").innerHTML = years.map((year) => {
    const cells = mixes.map((mix) => {
      const row = annualRows(mix.rows).find((item) => item.year === year);
      if (!row) return "<td>—</td>";
      return `<td class="${row.total < 0 ? "down" : "up"}">${pct(row.total)}${row.partial ? "*" : ""}</td>`;
    }).join("");
    return `<tr><td>${year}</td>${cells}</tr>`;
  }).join("");
}

async function main() {
  const data = await (await fetch("./history.json")).json();
  const ends = Object.values(data.series).map((series) => series.at(-1)[0]);
  document.querySelector("#updated").dataset.end = ends.sort().at(-1) || "";
  document.querySelector("#updated").textContent = data.updated_at
    ? `資料更新 ${data.updated_at.slice(0, 10)}`
    : "尚無資料";
  renderPicker(data);
  loadSettings();
  document.querySelector(".controls").addEventListener("change", saveSettings);
  document.querySelector("#add").addEventListener("click", () => addMix(data, selectedWeights()));
  document.querySelector("#window").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#window button").forEach((item) => {
      const on = item === button;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-pressed", String(on));
    });
    document.querySelector(".dates").hidden = button.dataset.years !== "custom";
    saveSettings();
    rebuildMixes(data);
  });
  document.querySelector("#rebalance").addEventListener("change", () => rebuildMixes(data));
  document.querySelector("#bench-dca").addEventListener("change", () => rebuildMixes(data));
  document.querySelector("#bench-amount").addEventListener("change", () => rebuildMixes(data));
  document.querySelector(".dates").addEventListener("change", () => rebuildMixes(data));
  document.querySelector("#chart-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#chart-mode button").forEach((item) => {
      const on = item === button;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-pressed", String(on));
    });
    draw();
  });
  document.querySelector("#chart").addEventListener("mousemove", hoverAt);
  document.querySelector("#chart").addEventListener("mouseleave", () => {
    document.querySelector("#hover").hidden = true;
    draw();
  });
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (saved.length) {
    saved.forEach((mix) => addMix(data, mix.weights, Boolean(mix.dca), true, mix.monthly || 10000));
    ensureBenchmark(data);
    return;
  }
  ensureBenchmark(data);
  const box = document.querySelector('input[value="0050.TW"]');
  const weight = box.closest(".pick").querySelector(".weight");
  box.checked = true;
  weight.disabled = false;
  weight.value = "100";
  addMix(data, { "0050.TW": 100 }, false);
}

main();
