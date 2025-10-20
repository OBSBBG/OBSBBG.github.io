// scripts/update_ticker.mjs
// Holt IMF/FRED-Serien + USD→EUR und schreibt ticker.json ins Repo-Root.
// Erfordert GitHub-Secret: FRED_API_KEY (Settings → Secrets → Actions).

import fs from "node:fs/promises";

// === Konfig ===
const SERIES = {
  cocoa: "PCOCOUSDM",     // Kakao, USD/t (monatlich)
  sugar: "PSUGAISAUSDM",  // Zucker, cent/lb (monatlich) -> in USD/t
  wheat: "PWHEAMTUSDM",   // Weizen, USD/t
  corn:  "PMAIZMTUSDM",   // Mais, USD/t
  rice:  "PRICENPQUSDM"   // Reis, USD/t
};
const START = "2024-01-01";
const OUTFILE = "ticker.json";

const FRED_API_KEY = process.env.FRED_API_KEY;
if (!FRED_API_KEY) {
  console.error("Fehler: FRED_API_KEY fehlt (Repo-Secret setzen).");
  process.exit(1);
}

// === Utils ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, { retries = 2, timeout = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new DOMException("Timeout", "TimeoutError")), timeout);
    try {
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await sleep(400 * (i + 1)); // 400/800ms Backoff
    }
  }
  throw lastErr;
}

function lastNonNull(observations) {
  for (let i = observations.length - 1; i >= 0; i--) {
    const raw = observations[i]?.value;
    if (raw !== "." && raw != null) return { date: observations[i].date, v: Number(raw) };
  }
  return null;
}
function prevNonNull(observations) {
  let found = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    const raw = observations[i]?.value;
    if (raw !== "." && raw != null) {
      found++;
      if (found === 2) return { date: observations[i].date, v: Number(raw) };
    }
  }
  return null;
}
function avgForYear(observations, year = "2024") {
  const vals = observations
    .filter(o => o.date.startsWith(`${year}-`))
    .map(o => (o.value === "." ? null : Number(o.value)))
    .filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function pct(cur, base) {
  if (base == null) return null;
  return ((cur - base) / base) * 100;
}
function monthLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { month: "short", year: "numeric" }); // z. B. “Okt. 2025”
}

// Zucker: cent/lb -> USD/t   (cent/lb * 22.04622 / 100? Nein: Serie ist bereits cent/lb; Faktor auf USD/t:)
const C_PER_LB_TO_USD_PER_T = 22.04622; // 1 cent/lb ≈ 22.04622 USD/t

async function fredSeries(series) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(FRED_API_KEY)}&file_type=json&observation_start=${encodeURIComponent(START)}`;
  const j = await fetchJSON(url);
  return j?.observations ?? [];
}
async function usdToEur() {
  const fx = await fetchJSON("https://api.exchangerate.host/latest?base=USD&symbols=EUR");
  return fx?.rates?.EUR ?? 0.93;
}
function toEURperT(kind, vUSDorCentLb, usd2eur) {
  if (kind === "sugar") {
    const usdPerT = vUSDorCentLb * C_PER_LB_TO_USD_PER_T;
    return usdPerT * usd2eur;
  }
  return vUSDorCentLb * usd2eur; // alle anderen sind bereits USD/t
}

function buildItem(label, kind, obs, usd2eur) {
  const cur  = lastNonNull(obs);
  if (!cur) return null;
  const prev = prevNonNull(obs);
  const avg24 = avgForYear(obs, "2024");

  const curEUR = toEURperT(kind, cur.v, usd2eur);
  const vsPrev = prev ? pct(cur.v, prev.v) : null;
  const vsAvg  = avg24 != null ? pct(cur.v, avg24) : null;

  const parts = [monthLabel(cur.date)];
  if (isFinite(vsPrev)) parts.push(`${vsPrev >= 0 ? "+" : ""}${vsPrev.toFixed(2).replace(".", ",")}% vs VM`);
  if (isFinite(vsAvg))  parts.push(`${vsAvg  >= 0 ? "+" : ""}${vsAvg .toFixed(2).replace(".", ",")}% vs 2024-Ø`);

  return {
    text: label,
    value: Math.round(curEUR),            // glatte EUR/t-Zahl
    extra: `EUR/t · ${parts.join(" • ")}`
  };
}

(async () => {
  console.log("Starte Ticker-Update …");
  const [usd2eur, cocoaObs, sugarObs, wheatObs, cornObs, riceObs] = await Promise.all([
    usdToEur(),
    fredSeries(SERIES.cocoa),
    fredSeries(SERIES.sugar),
    fredSeries(SERIES.wheat),
    fredSeries(SERIES.corn),
    fredSeries(SERIES.rice),
  ]);

  const items = [
    buildItem("🍫 Kakao", "cocoa", cocoaObs, usd2eur),
    buildItem("🍚 Zucker", "sugar", sugarObs, usd2eur),
    buildItem("🌾 Weizen", "wheat", wheatObs, usd2eur),
    buildItem("🌽 Mais",   "corn",  cornObs,  usd2eur),
    buildItem("🍚 Reis",   "rice",  riceObs,  usd2eur),
    { text: "Quelle: IMF über FRED (täglich aktualisiert)" }
  ].filter(Boolean);

  const out = { items };
  await fs.writeFile(OUTFILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`OK: ${OUTFILE} geschrieben (${items.length} Einträge).`);
})().catch(err => {
  console.error("Update fehlgeschlagen:", err?.message || err);
  process.exit(1);
});
