const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const key = "portfolio-compare-fire";

function yearsTo(now, save, target, rate) {
  if (now >= target) return 0;
  if (rate === 0) return save > 0 ? (target - now) / save : Infinity;
  let value = now;
  for (let year = 1; year <= 80; year += 1) {
    value = value * (1 + rate) + save;
    if (value >= target) return year;
  }
  return Infinity;
}

function coastNumber(target, rate, years) {
  if (years <= 0) return target;
  return target / (1 + rate) ** years;
}

function read() {
  return {
    now: Number(document.querySelector("#now").value) || 0,
    save: Number(document.querySelector("#save").value) || 0,
    spend: Number(document.querySelector("#spend").value) || 0,
    rate: Number(document.querySelector("#rate").value) / 100,
    swr: Number(document.querySelector("#swr").value) / 100,
    horizon: Number(document.querySelector("#horizon").value) || 0,
  };
}

function render() {
  const input = read();
  localStorage.setItem(key, JSON.stringify(input));
  const target = input.swr > 0 ? input.spend / input.swr : Infinity;
  const years = yearsTo(input.now, input.save, target, input.rate);
  const coast = coastNumber(target, input.rate, input.horizon);
  const gap = Math.max(target - input.now, 0);
  document.querySelector("#result").innerHTML = `
    <div><small>FIRE 目標</small><strong>${money.format(target)}</strong></div>
    <div><small>還差</small><strong>${money.format(gap)}</strong></div>
    <div><small>達標年數</small><strong>${Number.isFinite(years) ? `${years} 年` : "到不了"}</strong></div>
    <div><small>${input.horizon} 年 Coast 門檻</small><strong>${money.format(coast)}</strong></div>
  `;
}

const saved = JSON.parse(localStorage.getItem(key) || "null");
if (saved) {
  document.querySelector("#now").value = saved.now;
  document.querySelector("#save").value = saved.save;
  document.querySelector("#spend").value = saved.spend;
  document.querySelector("#rate").value = saved.rate * 100;
  document.querySelector("#swr").value = saved.swr * 100;
  document.querySelector("#horizon").value = saved.horizon ?? 10;
}
document.querySelector("#fire").addEventListener("input", render);
render();
