#!/usr/bin/env node
/* Pobere SIPX cene iz več virov in jih shrani v cene.json poleg index.html.
   Teče na GitHubu (ne v brskalniku), zato zanj ne veljajo omejitve klicev med domenami.
   Podatke ZDRUŽI z obstoječimi, da se zgodovina ohrani tudi, kadar vir vrne le en dan. */
const fs = require("fs");
const path = require("path");

const OUT = path.join(process.cwd(), "cene.json");
const TZ = "Europe/Ljubljana";
const KEEP_BACK = 10;   // dni zgodovine
const KEEP_FWD = 2;     // dni naprej

function ljNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// epoch za ljubljansko polnoč danega datuma (neodvisno od časovnega pasu strežnika)
function ljMidnight(y, m, d) {
  const off = (at) => {
    const x = new Date(at);
    return new Date(x.toLocaleString("en-US", { timeZone: TZ })).getTime()
         - new Date(x.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  };
  let t = Date.UTC(y, m, d, 0, 0, 0);
  t -= off(t);
  t -= off(t) - off(Date.UTC(y, m, d, 0, 0, 0));
  return t;
}

async function getJSON(url, headers) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: headers || {} });
    clearTimeout(to);
    if (!r.ok) return { err: "HTTP " + r.status };
    return { data: await r.json() };
  } catch (e) {
    clearTimeout(to);
    return { err: e.message };
  }
}

function pricesOf(j) {
  if (!j) return [];
  for (const k of ["price", "data", "values", "prices"]) {
    const v = j[k];
    if (Array.isArray(v) && v.length && typeof v[0] === "number") return v;
  }
  return [];
}

/* --- vir 1: energy-charts (15-min, glavni) --- */
async function fromEnergyCharts(log) {
  const d = ljNow();
  const s = new Date(d); s.setDate(d.getDate() - KEEP_BACK);
  const e = new Date(d); e.setDate(d.getDate() + KEEP_FWD);
  const urls = [
    `https://api.energy-charts.info/price?bzn=SI&start=${fmt(s)}&end=${fmt(e)}`,
    `https://api.energy-charts.info/price?bzn=SI`,
  ];
  const out = [];
  for (const u of urls) {
    const r = await getJSON(u);
    if (r.err) { log.push(`energy-charts ${u.includes("start") ? "obseg" : "tekoče"}: ${r.err}`); continue; }
    const us = (r.data && r.data.unix_seconds) || [], pr = pricesOf(r.data);
    if (!us.length || !pr.length) { log.push("energy-charts: odgovor brez cen"); continue; }
    for (let i = 0; i < us.length; i++) if (pr[i] != null) out.push([us[i], pr[i]]);
    log.push(`energy-charts ${u.includes("start") ? "obseg" : "tekoče"}: ${us.length} vrednosti`);
  }
  return out;
}

/* --- vir 2: euenergy (urno, rezerva) --- */
async function fromEuenergy(token, log) {
  if (!token) { log.push("euenergy: ni žetona, preskočeno"); return []; }
  const out = [];
  for (const day of ["today", "tomorrow"]) {
    const r = await getJSON(`https://euenergy.live/api/v1/prices/${day}?zone=SI`,
      { Authorization: "Bearer " + token });
    if (r.err) { log.push(`euenergy ${day}: ${r.err}`); continue; }
    const j = r.data || {};
    if (j.status && j.status !== "ok") { log.push(`euenergy ${day}: ${j.status}`); continue; }
    const hrs = j.hours || [];
    if (!hrs.length) { log.push(`euenergy ${day}: prazno`); continue; }
    let n = 0;
    hrs.forEach((h) => {
      const t = new Date(h.time || h.start || h.hour || h.datetime);
      const p = Number(h.price ?? h.eur_mwh ?? h.value);
      if (isNaN(t.getTime()) || isNaN(p)) return;
      // urno -> 4 x 15 min, da se ujema z glavnim virom
      for (let q = 0; q < 4; q++) out.push([Math.floor(t.getTime() / 1000) + q * 900, p]);
      n++;
    });
    log.push(`euenergy ${day}: ${n} ur`);
  }
  return out;
}

(async () => {
  const log = [];
  let merged = new Map();

  // obstoječe cene ohranimo
  if (fs.existsSync(OUT)) {
    try {
      const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
      (old.unix_seconds || []).forEach((s, i) => {
        const p = (old.price || [])[i];
        if (p != null) merged.set(s, p);
      });
      log.push(`obstoječe: ${merged.size} vrednosti`);
    } catch (e) { log.push("obstoječe: neberljivo, začnem znova"); }
  }

  const before = merged.size;
  for (const [s, p] of await fromEnergyCharts(log)) merged.set(s, p);
  const afterEC = merged.size;

  // rezervo uporabimo le, če glavni vir ni prinesel jutrišnjega dne
  const d = ljNow();
  const needUntil = ljMidnight(d.getFullYear(), d.getMonth(), d.getDate() + 1) + 23 * 3600000;
  const haveTomorrow = [...merged.keys()].some((s) => s * 1000 >= needUntil);
  if (!haveTomorrow) {
    for (const [s, p] of await fromEuenergy(process.env.EUENERGY_TOKEN, log)) merged.set(s, p);
  } else {
    log.push("jutri že imamo, rezerva ni potrebna");
  }

  // pospravi okno
  const lo = ljMidnight(d.getFullYear(), d.getMonth(), d.getDate() - KEEP_BACK) / 1000;
  const hi = ljMidnight(d.getFullYear(), d.getMonth(), d.getDate() + KEEP_FWD + 1) / 1000;
  const keys = [...merged.keys()].filter((s) => s >= lo && s < hi).sort((a, b) => a - b);
  if (!keys.length) {
    console.error("Ni nobene cene, datoteke ne pišem.");
    log.forEach((l) => console.error("  " + l));
    process.exit(1);
  }

  const out = {
    unix_seconds: keys,
    price: keys.map((k) => merged.get(k)),
    unit: "EUR / MWh",
    updated: new Date().toISOString(),
    source: "energy-charts.info; rezerva euenergy.live (CC-BY-4.0)",
    log,
  };

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  const next = JSON.stringify(out);
  fs.writeFileSync(OUT, next);

  const cmp = (t) => { try { const j = JSON.parse(t); return JSON.stringify([j.unix_seconds, j.price]); } catch (e) { return ""; } };
  const changed = cmp(prev) !== cmp(next);
  console.log(`vrednosti: ${before} -> ${afterEC} -> ${keys.length} | spremenjeno: ${changed ? "da" : "ne"}`);
  log.forEach((l) => console.log("  " + l));
  fs.writeFileSync(process.env.GITHUB_OUTPUT || "/dev/null", `changed=${changed ? "1" : "0"}\n`, { flag: "a" });
})();
