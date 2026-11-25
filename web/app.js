const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });

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
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return {
    start: rows[0][0],
    end: rows[rows.length - 1][0],
    months: rows.length,
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
  return [...grouped.entries()].map(([year, values]) => {
    const total = values.reduce((product, value) => product * (1 + value), 1) - 1;
    return { year, total, partial: values.length < 12 };
  });
}

function renderPicker(data) {
  const picker = document.querySelector("#picker");
  picker.innerHTML = "";
  data.symbols.forEach((item) => {
    const row = document.createElement("label");
    row.className = "pick";
    row.innerHTML = `
      <input type="checkbox" value="${item.symbol}">
      <span>
        <strong>${item.symbol}</strong>
        <small>${item.name} · ${item.market}</small>
      </span>
      <input class="weight" type="number" min="0" max="100" value="50" disabled>
    `;
    const box = row.querySelector('input[type="checkbox"]');
    const weight = row.querySelector(".weight");
    box.addEventListener("change", () => {
      weight.disabled = !box.checked;
      compare(data);
    });
    weight.addEventListener("input", () => compare(data));
    picker.appendChild(row);
  });
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

function draw(rows) {
  const canvas = document.querySelector("#chart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  let growth = 10000;
  const points = rows.map(([, value]) => {
    growth *= 1 + value;
    return growth;
  });
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = 28;
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((value, index) => {
    const x = pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
    const y = pad + (1 - (value - min) / Math.max(max - min, 1)) * (height - pad * 2);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#6b7280";
  ctx.font = "13px sans-serif";
  ctx.fillText(money.format(max), pad + 6, pad + 14);
  ctx.fillText(money.format(min), pad + 6, height - pad - 6);
}

function compare(data) {
  const note = document.querySelector("#note");
  const stats = document.querySelector("#stats");
  const years = document.querySelector("#years");
  try {
    const weights = selectedWeights();
    const symbols = Object.keys(weights);
    const rows = portfolioReturns(overlap(symbols, data.series), symbols, weights);
    if (rows.length < 2) throw new Error("重疊月份不夠");
    const summary = summarize(rows);
    note.textContent = `${summary.start} → ${summary.end} · ${summary.months} 個月 · 每年 1 月再平衡 · 1 萬元`;
    stats.innerHTML = [
      ["年化", pct(summary.cagr)],
      ["波動", pct(summary.volatility)],
      ["最大回撤", pct(summary.maxDrawdown)],
      ["期末", money.format(summary.final)],
    ].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join("");
    years.innerHTML = annualRows(rows)
      .map((row) => `<tr><td>${row.year}${row.partial ? "*" : ""}</td><td class="${row.total < 0 ? "down" : "up"}">${pct(row.total)}</td></tr>`)
      .join("");
    draw(rows);
  } catch (error) {
    note.textContent = error.message;
    stats.innerHTML = "";
    years.innerHTML = "";
  }
}

async function main() {
  const response = await fetch("./history.json");
  const data = await response.json();
  document.querySelector("#updated").textContent = data.updated_at
    ? `資料更新 ${data.updated_at.slice(0, 10)}`
    : "尚無資料";
  renderPicker(data);
  ["0050.TW", "00679B.TWO"].forEach((symbol) => {
    const box = document.querySelector(`input[value="${symbol}"]`);
    box.checked = true;
    box.closest(".pick").querySelector(".weight").disabled = false;
  });
  compare(data);
}

main();
