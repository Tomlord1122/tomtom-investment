const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const colors = ["#1f2937", "#0f766e", "#b45309", "#1d4ed8", "#9f1239"];
const storageKey = "portfolio-compare-mixes-v2";
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

function windowStart() {
  const years = Number(document.querySelector("#window").value);
  if (!years) return "";
  const end = document.querySelector("#updated").dataset.end;
  if (!end) return "";
  const [year, month] = end.split("-").map(Number);
  const start = new Date(Date.UTC(year - years, month - 1, 1));
  return start.toISOString().slice(0, 7);
}

function overlap(selected, series) {
  const maps = selected.map((symbol) => new Map(returnsFromSeries(series[symbol])));
  const start = windowStart();
  const months = [...maps[0].keys()].filter((month) => month >= start && maps.every((item) => item.has(month)));
  months.sort();
  return months.map((month) => [month, selected.map((symbol, index) => maps[index].get(month))]);
}

function portfolioReturns(rows, symbols, weights) {
  const target = normalize(weights);
  const order = symbols.map((symbol) => target[symbol]);
  let held = order.slice();
  let year = null;
  return rows.map(([month, assetReturns]) => {
    const nextYear = month.slice(0, 4);
    if (year !== nextYear) {
      held = order.slice();
      year = nextYear;
    }
    const portfolio = held.reduce((sum, weight, index) => sum + weight * assetReturns[index], 0);
    const grown = held.map((weight, index) => weight * (1 + assetReturns[index]));
    const total = grown.reduce((sum, value) => sum + value, 0);
    held = grown.map((value) => value / total);
    return [month, portfolio];
  });
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
    final: 10000 * growth,
  };
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

function saveMixes() {
  const saved = mixes.map(({ name, weights, dca }) => ({ name, weights, dca }));
  localStorage.setItem(storageKey, JSON.stringify(saved));
}

function rebuildMixes(data) {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  mixes.splice(0);
  saved.forEach((mix) => addMix(data, mix.weights, Boolean(mix.dca), false));
  if (!mixes.length && saved.length) document.querySelector("#note").textContent = "這個區間裡，已存的組合沒有足夠月份";
}

function addMix(data, weights, dca = document.querySelector("#dca").checked, persist = true) {
  const note = document.querySelector("#note");
  try {
    const clean = normalize(weights);
    const symbols = Object.keys(clean);
    const rows = portfolioReturns(overlap(symbols, data.series), symbols, clean);
    if (rows.length < 2) throw new Error("重疊月份不夠");
    if (mixes.length >= colors.length) throw new Error("最多五組");
    mixes.push({
      name: label(clean) + (dca ? " · 定額" : ""),
      weights: clean,
      dca,
      rows,
      curve: dca ? dcaValue(rows) : null,
      summary: summarize(rows),
      color: colors[mixes.length],
    });
    note.textContent = "";
    if (persist) saveMixes();
    draw();
  } catch (error) {
    note.textContent = error.message;
  }
}

function curveOf(mix) {
  if (mix.dca) return mix.curve.map(([, value]) => value);
  let growth = 10000;
  return mix.rows.map(([, value]) => {
    growth *= 1 + value;
    return growth;
  });
}

function scales() {
  const curves = mixes.map(curveOf);
  const longest = Math.max(...curves.map((points) => points.length), 1);
  const flat = curves.flat();
  return {
    curves,
    longest,
    min: Math.min(...flat, 10000),
    max: Math.max(...flat, 10000),
  };
}

function pointAt(length, index, value, scale) {
  const canvas = document.querySelector("#chart");
  const x = pad + (index / Math.max(scale.longest - 1, 1)) * (canvas.width - pad * 2);
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
  scale.curves.forEach((points, index) => {
    ctx.strokeStyle = mixes[index].color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach((value, point) => {
      const [x, y] = pointAt(points.length, point, value, scale);
      if (point === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  renderTables();
}

function hoverAt(event) {
  const box = document.querySelector("#hover");
  if (!mixes.length) return;
  const canvas = document.querySelector("#chart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const scale = scales();
  const index = Math.round(((x - pad) / (canvas.width - pad * 2)) * Math.max(scale.longest - 1, 1));
  if (index < 0 || index >= scale.longest) {
    box.hidden = true;
    draw();
    return;
  }
  draw();
  const ctx = canvas.getContext("2d");
  const lineX = pointAt(scale.longest, index, scale.min, scale)[0];
  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(lineX, pad);
  ctx.lineTo(lineX, canvas.height - pad);
  ctx.stroke();
  const rows = mixes.map((mix, mixIndex) => {
    if (index >= mix.rows.length) return `<div style="color:${mix.color}">${mix.name} —</div>`;
    const month = mix.rows[index][0];
    const value = scale.curves[mixIndex][index];
    const contributed = mix.dca ? mix.curve[index][2] : 10000;
    const gain = value / contributed - 1;
    return `<div style="color:${mix.color}">${month} ${mix.name}<br>${money.format(value)} · ${pct(gain)}</div>`;
  });
  box.hidden = false;
  box.innerHTML = rows.join("");
}

function renderTables() {
  document.querySelector("#legend").innerHTML = mixes.map((mix, index) =>
    `<span><i class="swatch" style="background:${mix.color}"></i>${mix.name}<button class="remove" data-index="${index}" type="button">移除</button></span>`
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
      <td>${money.format(mix.dca ? mix.curve.at(-1)[1] : mix.summary.final)}</td>
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
  document.querySelector("#add").addEventListener("click", () => addMix(data, selectedWeights()));
  document.querySelector("#window").addEventListener("change", () => rebuildMixes(data));
  document.querySelector("#chart").addEventListener("mousemove", hoverAt);
  document.querySelector("#chart").addEventListener("mouseleave", () => {
    document.querySelector("#hover").hidden = true;
    draw();
  });
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (saved.length) {
    saved.forEach((mix) => addMix(data, mix.weights, Boolean(mix.dca)));
    return;
  }
  const box = document.querySelector('input[value="0050.TW"]');
  const weight = box.closest(".pick").querySelector(".weight");
  box.checked = true;
  weight.disabled = false;
  weight.value = "100";
  addMix(data, { "0050.TW": 100 }, false);
}

main();
