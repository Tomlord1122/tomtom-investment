const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const colors = ["#1f2937", "#0f766e", "#b45309", "#1d4ed8", "#9f1239"];
const mixes = [];

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

function overlap(selected, series) {
  const maps = selected.map((symbol) => new Map(returnsFromSeries(series[symbol])));
  const months = [...maps[0].keys()].filter((month) => maps.every((item) => item.has(month)));
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
}

function addMix(data) {
  const note = document.querySelector("#note");
  try {
    const weights = normalize(selectedWeights());
    const symbols = Object.keys(weights);
    const rows = portfolioReturns(overlap(symbols, data.series), symbols, weights);
    if (rows.length < 2) throw new Error("重疊月份不夠");
    if (mixes.length >= colors.length) throw new Error("最多五組");
    mixes.push({ name: label(weights), rows, summary: summarize(rows), color: colors[mixes.length] });
    note.textContent = "";
    draw();
  } catch (error) {
    note.textContent = error.message;
  }
}

function draw() {
  const canvas = document.querySelector("#chart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 28;
  ctx.clearRect(0, 0, width, height);
  const curves = mixes.map((mix) => {
    let growth = 10000;
    return mix.rows.map(([, value]) => {
      growth *= 1 + value;
      return growth;
    });
  });
  const flat = curves.flat();
  const min = Math.min(...flat, 10000);
  const max = Math.max(...flat, 10000);
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath();
  ctx.moveTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();
  curves.forEach((points, index) => {
    ctx.strokeStyle = mixes[index].color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach((value, point) => {
      const x = pad + (point / Math.max(points.length - 1, 1)) * (width - pad * 2);
      const y = pad + (1 - (value - min) / Math.max(max - min, 1)) * (height - pad * 2);
      if (point === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  renderTables();
}

function renderTables() {
  document.querySelector("#legend").innerHTML = mixes.map((mix, index) =>
    `<span><i class="swatch" style="background:${mix.color}"></i>${mix.name}<button class="remove" data-index="${index}" type="button">移除</button></span>`
  ).join("");
  document.querySelectorAll(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      mixes.splice(Number(button.dataset.index), 1);
      mixes.forEach((mix, index) => { mix.color = colors[index]; });
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
      <td>${money.format(mix.summary.final)}</td>
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
  document.querySelector("#updated").textContent = data.updated_at
    ? `資料更新 ${data.updated_at.slice(0, 10)}`
    : "尚無資料";
  renderPicker(data);
  document.querySelector("#add").addEventListener("click", () => addMix(data));
  ["0050.TW", "00679B.TWO"].forEach((symbol) => {
    const box = document.querySelector(`input[value="${symbol}"]`);
    box.checked = true;
    box.closest(".pick").querySelector(".weight").disabled = false;
  });
  addMix(data);
}

main();
