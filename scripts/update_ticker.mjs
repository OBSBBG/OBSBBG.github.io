// scripts/update_ticker.mjs
// Holt IMF/FRED-Serien + USD→EUR und schreibt ticker.json ins Repo-Root.
// Erwartet GitHub-Secret: FRED_API_KEY. Bei Fehlern wird ein Fallback geschrieben,
// damit ticker.json IMMER existiert (wichtig für den Commit-Step).

import fs from "node:fs/promises";

const SERIES = {
  cocoa: "PCOCOUSDM",     // USD/t (monatlich)
  sugar: "PSUGAISAUSDM",  // cent/lb (monatlich) → USD/t
  wheat: "PWHEAMTUSDM",   // USD/t
  corn:  "PMAIZMTUSDM",   // USD/t
  rice:  "PRICENPQUSDM"   // USD/t
};
const START   = "2024-01-01";
const OUTFILE = "ticker.json";

const FRED_API_KEY = process.env.FRED_API_KEY;

// --- Utils ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, { retries = 2, timeout = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error("Timeout")), timeout);
    try {
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

function lastNonNull(observations) {
  for (let i = observations.length - 1; i >= 0; i--) {
    const v = observations[i]?.value;
    if (v !== "." && v != null) return { date: observations[i].date, v: Number(v) };
  }
  return null;
}
function prevNonNull(observations) {
  let found = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    const v = observations[i]?.value;
    if (v !== "." && v != null) {
      found++;
      if (found === 2) return { date: observations[i].date, v: Number(v) };
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
  return d.toLocaleDateString("de-DE", { month: "short", year: "numeric" });
}

// 1 cent/lb = $0.01/lb; 1 t = 2204.62262 lb → 0.01 * 2204.62262 = 22.04622 USD/t pro cent/lb
const C_PER_LB_TO_USD_PER_T = 22.04622;

async function fredSeries(series) {
  if (!FRED_API_KEY) throw new Error("FRED_API_KEY fehlt");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(FRED_API_KEY)}&file_type=json&observation_start=${encodeURIComponent(START)}`;
  const j = await fetchJSON(url);
  return j?.observations ?? [];
}
async function usdToEur() {
  const fx = await fetchJSON("https://api.exchangerate.host/latest?base=USD&symbols=EUR");
  return fx?.rates?.EUR ?? 0.93;
}
function toEURperT(kind, vUSDorCentLb, usd2eur) {
  if (kind === "sugar") return vUSDorCentLb * C_PER_LB_TO_USD_PER_T * usd2eur;
  return vUSDorCentLb * usd2eur;
}

function buildItem(label, kind, obs, usd2eur) {
  const cur = lastNonNull(obs);
  if (!cur) return null;
  const prev = prevNonNull(obs);
  const avg24 = avgForYear(obs, "2024");

  const curEUR = toEURperT(kind, cur.v, usd2eur);
  const vsPrev = prev ? pct(cur.v, prev.v) : null;
  const vsAvg  = avg24 != null ? pct(cur.v, avg24) : null;

  const parts = [monthLabel(cur.date)];
  if (isFinite(vsPrev)) parts.push(`${vsPrev >= 0 ? "+" : ""}${vsPrev.toFixed(2).replace(".", ",")}% vs VM`);
  if (isFinite(vsAvg))  parts.push(`${vsAvg  >= 0 ? "+" : ""}${vsAvg .toFixed(2).replace(".", ",")}% vs 2024-Ø`);

  return { text: label, value: Math.round(curEUR), extra: `EUR/t • ${parts.join(" • ")}` };
}

function fallbackData(reason = "Fallback") {
  return {
    items: [
      { text: "🍫 Kakao", value: 4200, extra: "EUR/t • " + reason },
      { text: "🍚 Zucker", value: 680,  extra: "EUR/t • " + reason },
      { text: "🌾 Weizen", value: 255,  extra: "EUR/t • " + reason },
      { text: "🌽 Mais",   value: 205,  extra: "EUR/t • " + reason },
      { text: "🍚 Reis",   value: 520,  extra: "EUR/t • " + reason },
      { text: "Quelle: IMF über FRED (" + reason + ")" }
    ]
  };
}

(async () => {
  try {
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

    // Falls aus irgendeinem Grund keine Items generiert wurden, nimm Fallback
    const out = items.length ? { items } : fallbackData("leer");
    await fs.writeFile(OUTFILE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`OK: ${OUTFILE} geschrieben (${out.items.length} Einträge).`);
  } catch (err) {
    console.error("WARNUNG: Live-Update fehlgeschlagen:", err?.message || err);
    const out = fallbackData("Fehler");
    await fs.writeFile(OUTFILE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`FALLBACK: ${OUTFILE} geschrieben.`);
    // KEIN process.exit(1) → damit der Commit-Step sicher läuft.
  }
})();
