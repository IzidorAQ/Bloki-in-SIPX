#!/usr/bin/env node
/* Izračun računa GEN-I (Dinamični) iz merilnih podatkov Moj Elektro in borznih cen SIPX.
   Teče na GitHubu; žeton je v skrivnosti MOJELEKTRO_TOKEN in NIKOLI ne gre v javno datoteko.
   V racuni.json se shranijo SAMO mesečni povzetki (znesek, kWh po blokih, obračunska moč),
   nikoli 15-minutni podatki, ki bi razkrivali, kdaj ste doma.
   Formula je preverjena na računih za junij, julij in avgust 2026: vsi trije se ujemajo do centa.
   Pravilo obračunske moči in zaokroževanje po blokih sta potrjena na 15-minutnih podatkih iz Moj Elektro. */
const fs = require("fs");
const path = require("path");
const OUT = path.join(process.cwd(), "racuni.json");
const API = "https://api.informatika.si/mojelektro/v1";
const USAGE_POINT = process.env.MOJELEKTRO_USAGE_POINT || "383111580019506391";   // GS1 GSRN merilnega mesta
const RT_ENERGY = "32.0.2.4.1.2.12.0.0.0.0.0.0.0.0.3.72.0";   // prejeta 15-min delovna energija, kWh
const RT_POWER  = "32.0.2.4.1.2.37.0.0.0.0.0.0.0.0.3.38.0";   // prejeta 15-min delovna moč, kW
const TZ = "Europe/Ljubljana";

// ---- logika blokov, prenesena NESPREMENJENA iz index.html (preverjena na julijski specifikaciji) ----
const SCHED_2026 = {
  "visoka|delovni": [[0,6,3],[6,7,2],[7,14,1],[14,16,2],[16,20,1],[20,22,2],[22,24,3]],
  "visoka|prost":   [[0,6,4],[6,7,3],[7,14,2],[14,16,3],[16,20,2],[20,22,3],[22,24,4]],
  "nizka|delovni":  [[0,6,4],[6,7,3],[7,14,2],[14,16,3],[16,20,2],[20,22,3],[22,24,4]],
  "nizka|prost":    [[0,6,5],[6,7,4],[7,14,3],[14,16,4],[16,20,3],[20,22,4],[22,24,5]]
};
// NOVI urnik, velja od 1.1.2027 (Ur.l. RS 76/2025)
const SCHED_2027 = {
  "visoka|delovni": [[0,6,3],[6,12,1],[12,17,2],[17,20,1],[20,22,2],[22,24,3]],
  "visoka|prost":   [[0,6,4],[6,12,3],[12,17,4],[17,22,3],[22,24,4]],
  "nizka|delovni":  [[0,6,5],[6,12,3],[12,17,4],[17,22,3],[22,24,5]],
  "nizka|prost":    [[0,6,5],[6,12,4],[12,17,5],[17,22,4],[22,24,5]]
};
function schedSet(d){ return d.getFullYear()>=2027 ? SCHED_2027 : SCHED_2026; }
// blok po izbranem urniku (za primerjavo sedanjih pravil in pravil 2027)
function schedForSet(d,SC){ return SC[season(d)+"|"+dayType(d)]; }
function blockAtSet(d,SC){
  const h=d.getHours()+d.getMinutes()/60;
  for(const [s,e,b] of schedForSet(d,SC)) if(h>=s&&h<e) return b;
  return schedForSet(d,SC)[0][2];
}
// nariše trak blokov + mejne ure v dana elementa
const CONFIRMED = {"visoka|delovni":true,"visoka|prost":true,"nizka|delovni":true,"nizka|prost":true};

/* ============================================================
   ČAS / SEZONA / DAN
   ============================================================ */
function nowLjubljana(){
  // čas v coni Europe/Ljubljana ne glede na cono naprave
  const s = new Date().toLocaleString("en-US",{timeZone:"Europe/Ljubljana"});
  return new Date(s);
}
function easter(y){ // Gauss / Anonymous Gregorian
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
  f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
  i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
  mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  return new Date(y,mo-1,da);
}
function isHoliday(d){
  const md=(d.getMonth()+1)*100+d.getDate();
  const fixed=[101,102,208,427,501,502,625,815,1031,1101,1225,1226];
  if(fixed.includes(md)) return true;
  const e=easter(d.getFullYear()), em=new Date(e); em.setDate(e.getDate()+1); // velikonočni pon.
  const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  return sameDay(d,e)||sameDay(d,em);
}
function dayType(d){ const w=d.getDay(); return (w===0||w===6||isHoliday(d))?"prost":"delovni"; }
function season(d){ const m=d.getMonth()+1; return (m===11||m===12||m===1||m===2)?"visoka":"nizka"; }
function schedFor(d){ return schedSet(d)[season(d)+"|"+dayType(d)]; }
function blockAt(d){
  const h=d.getHours()+d.getMinutes()/60;
  for(const [s,e,b] of schedFor(d)) if(h>=s&&h<e) return b;
  return schedFor(d)[0][2];
}
function b1Mult(d){
  const m=d.getMonth()+1, y=d.getFullYear();
  const start=(m>=11)?y:y-1; // leto začetka višje sezone
  if(start<=2024) return 1; if(start===2025) return .5;
  if(start===2026) return .7; if(start===2027) return .9; return 1;
}

// ---- cene (brez DDV); preverjene na računih ----
const MOC = {1:3.82301, 2:1.09230, 3:0.28902, 4:0.02436, 5:0.00245};   // EUR/kW/mesec (blok 1 x b1Mult)
const ENB = {1:0.02217, 2:0.01998, 3:0.01717, 4:0.01805, 5:0.01299};   // EUR/kWh
const C = { markup:0.01199, cap:0.22, opTrga:0.00013, ucink:0.0008, spte:0.77562,
            tros:0.00153, nadom:2.97, eko:-1.00, ddv:0.22 };
const r2 = x => Math.round((x + 1e-12) * 100) / 100;

function ljParts(ms){                     // ljubljanski datum/ura iz epohe
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: TZ }));
  return d;
}
function ljMidnight(y, m, d){              // epoha ljubljanske polnoči (neodvisno od strežnika)
  const off = at => { const x = new Date(at);
    return new Date(x.toLocaleString("en-US",{timeZone:TZ})).getTime()
         - new Date(x.toLocaleString("en-US",{timeZone:"UTC"})).getTime(); };
  let t = Date.UTC(y, m, d); t -= off(t); t -= off(t) - off(Date.UTC(y, m, d)); return t;
}
const iso = ms => new Date(ms).toISOString().slice(0,10);

async function getJSON(url, headers){
  for (let i = 0; i < 3; i++){
    try {
      const r = await fetch(url, { headers: Object.assign({ Accept:"application/json" }, headers||{}) });
      if (r.ok) return { data: await r.json() };
      const body = (await r.text()).slice(0, 200);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return { err: `HTTP ${r.status} ${body}` };
    } catch (e) { if (i === 2) return { err: e.message }; }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  return { err: "ni odgovora" };
}

// 15-minutne vrednosti iz Moj Elektro za [od, do) po tedenskih kosih (obseg zahtevka je lahko omejen)
async function mojElektro(readingType, fromMs, toMs, log){
  const tok = process.env.MOJELEKTRO_TOKEN;
  if (!tok) throw new Error("manjka skrivnost MOJELEKTRO_TOKEN");
  const out = new Map();
  for (let a = fromMs; a < toMs; a += 7*864e5){
    const b = Math.min(toMs, a + 7*864e5);
    const url = `${API}/meter-readings?usagePoint=${USAGE_POINT}&startTime=${iso(a)}&endTime=${iso(b+864e5)}`+
                `&option=${encodeURIComponent("ReadingType="+readingType)}`;
    const r = await getJSON(url, { "X-API-TOKEN": tok });
    if (r.err){ log.push(`Moj Elektro ${iso(a)}: ${r.err}`); continue; }
    let n = 0;
    (r.data.intervalBlocks || []).forEach(blk => (blk.intervalReadings || []).forEach(v => {
      const t = Date.parse(v.timestamp), val = parseFloat(v.value);
      if (!isNaN(t) && !isNaN(val)){ out.set(t, val); n++; }
    }));
    log.push(`Moj Elektro ${readingType.split(".")[6]==="37"?"moč":"energija"} ${iso(a)}..${iso(b)}: ${n} vrednosti`);
  }
  return out;
}

// SIPX za [od, do); GEN-I obračuna URNO = aritmetična sredina štirih četrturnih cen
async function sipx(fromMs, toMs, log){
  const r = await getJSON(`https://api.energy-charts.info/price?bzn=SI&start=${iso(fromMs-864e5)}&end=${iso(toMs+864e5)}`);
  if (r.err){ log.push("SIPX: "+r.err); return new Map(); }
  const us = r.data.unix_seconds || [], pr = r.data.price || [], acc = new Map();
  us.forEach((s, i) => { const t = s*1000; if (t < fromMs || t >= toMs || pr[i]==null) return;
    const h = Math.floor(t/36e5)*36e5; const a = acc.get(h) || [0,0]; a[0]+=pr[i]; a[1]++; acc.set(h,a); });
  const out = new Map(); acc.forEach((a,h) => out.set(h, a[0]/a[1]/1000));   // EUR/kWh
  log.push(`SIPX: ${out.size} urnih cen`);
  return out;
}

// ---- izračun računa za en mesec (preverjena formula) ----
function izracunaj(y, m, energy15, power15, prices, shift){
  const from = ljMidnight(y, m, 1), to = ljMidnight(y, m+1, 1);
  const hourKwh = new Map(); let kwh = 0;
  const blkKwh = {1:0,2:0,3:0,4:0,5:0}, peak = {1:0,2:0,3:0,4:0,5:0};
  let lastTs = from, missingPrice = 0;
  const endLabel = shift > 0;
  let stMeritev = 0;
  energy15.forEach((v, t) => {
    const start = t - shift;
    if (start < from || start >= to) return;
    stMeritev++;
    const h = Math.floor(start/36e5)*36e5;
    hourKwh.set(h, (hourKwh.get(h)||0) + v); kwh += v;
    blkKwh[blockAt(ljParts(start))] += v; lastTs = Math.max(lastTs, t);
  });
  const peakTs = {};
  power15.forEach((v, t) => {
    const start = t - shift;
    if (start < from || start >= to) return;
    const b = blockAt(ljParts(start)); if (v > peak[b]){ peak[b] = v; peakTs[b] = start; }
  });
  // obračunska moč: največja 15-min moč v bloku, nato naraščajoče po blokih (P2<=P3<=P4<=P5)
  const blocks = Object.keys(peak).map(Number).filter(b => blkKwh[b]>0 || peak[b]>0 || b>=2);
  const winter = [11,12,1,2].includes(m+1);
  const order = winter ? [1,2,3,4,5] : [2,3,4,5];
  // Obračunska moč = vrh ISTEGA meseca v bloku, zaokrožen na 0,1 kW, in ne nižji od bloka pred njim.
  // Potrjeno na 15-min podatkih: julij 8,7/18,6/18,6/18,6 in avgust 18,6/20,6/20,6/20,6 se ujemata z računoma.
  const P = {}, izvor = {}; let prev = 0, prevB = null;
  order.forEach(b => {
    const lasten = Math.round(peak[b]*10)/10;
    if (lasten >= prev){ P[b] = lasten; izvor[b] = b; } else { P[b] = prev; izvor[b] = izvor[prevB]; }
    prev = P[b]; prevB = b;
  });
  const fmt = ms => { const d = ljParts(ms);
    return `${d.getDate()}. ${d.getMonth()+1}. ob ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
  const vrh = {}; order.forEach(b => { vrh[b] = { lasten:+(Math.round(peak[b]*100)/100), izvor:izvor[b],
                                              ob: peakTs[izvor[b]] != null ? fmt(peakTs[izvor[b]]) : null }; });
  let energija = 0;
  // Dobavitelj meritve distributerja preračuna na celo število kWh z računa (npr. 495,25 -> 495)
  // in šele nato obračuna po urah. Potrjeno na julijski specifikaciji.
  const scale = kwh > 0 ? Math.round(kwh) / kwh : 1;
  hourKwh.forEach((k, h) => { const p = prices.get(h);
    if (p == null){ missingPrice++; return; }
    energija += k * scale * (Math.min(p, C.cap) + C.markup); });
  const dni = new Date(y, m+1, 0).getDate();
  const pokrito = Math.max(0, Math.min(1, stMeritev / ((to - from) / 9e5)));
  const b1 = b1Mult(new Date(y, m, 15));
  const L = {};
  L.energija = r2(energija);
  order.forEach(b => { L["moc"+b] = r2(P[b] * MOC[b] * (b===1?b1:1)); });
  // Poraba po blokih: vsak blok zaokrožen, razlika do skupne (zaokrožene) porabe gre v zadnji blok.
  // Potrjeno na junijskem, julijskem in avgustovskem računu.
  const K = Math.round(kwh);
  const blkR = {}; order.forEach(b => blkR[b] = Math.round(blkKwh[b]));
  blkR[order[order.length-1]] += K - order.reduce((a,b)=>a+blkR[b],0);
  order.forEach(b => { L["ee"+b] = r2(blkR[b] * ENB[b]); });
  L.opTrga = r2(K*C.opTrga); L.ucink = r2(K*C.ucink);
  L.spte = r2(P[order[0]] * C.spte);
  L.tros = r2(K*C.tros); L.nadom = r2(C.nadom); L.eko = r2(C.eko);
  const osnova = r2(Object.values(L).reduce((a,b)=>a+b,0)), ddv = r2(osnova*C.ddv);
  // NAPOVED za cel mesec, dokler ni pokrit: postavke po kWh raztegnemo na cel mesec,
  // moč ostane pri do zdaj izmerjenem vrhu (lahko se še zviša), fiksne postavke so že cele.
  let napoved = null;
  const pokr = Math.max(0, Math.min(1, stMeritev / ((to - from) / 9e5)));
  if (pokr > 0.02 && pokr < 0.999){
    const poKwh = ["energija","opTrga","ucink","tros"].concat(order.map(b=>"ee"+b));
    const nOsn = r2(Object.entries(L).reduce((a,[k,v]) => a + (poKwh.includes(k) ? v/pokr : v), 0));
    napoved = { osnova:nOsn, ddv:r2(nOsn*C.ddv), skupaj:r2(nOsn + r2(nOsn*C.ddv)), kwh:+(kwh/pokr).toFixed(0) };
  }
  return { mesec:`${y}-${String(m+1).padStart(2,"0")}`, kwh:+kwh.toFixed(2),
    bloki:Object.fromEntries(order.map(b=>[b,+blkKwh[b].toFixed(2)])),
    moc:Object.fromEntries(order.map(b=>[b,+P[b].toFixed(2)])), vrh, b1: b1Mult(new Date(y, m, 15)),
    postavke:L, osnova, ddv, skupaj:r2(osnova+ddv), napoved, pokrito:+pokrito.toFixed(3),
    manjkaCen:missingPrice, oznaka:endLabel?"konec":"zacetek", stMeritev,
    izmerjenoDo: (() => { const d = ljParts(lastTs - shift); return `${d.getDate()}. ${d.getMonth()+1}.`; })() };
}

(async () => {
  const log = [];
  let store = { racuni:{}, izracuni:{} };
  try { store = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) {}
  store.racuni = store.racuni || {}; store.izracuni = store.izracuni || {};

  // Dejanski računi (iz PDF-jev). Služijo za zgodovino in za preverjanje izračuna.
  Object.assign(store.racuni, {
    "2026-06": { racun:"IR32708612", obdobje:"18.6.-30.6.", kwh:102, osnova:16.78, ddv:3.69, skupaj:20.47,
                 energija:8.84, omreznina:5.37, prispevki:1.56, trosarina:0.16, nadomestilo:0.85,
                 moc:{2:1.9,3:4.8,4:4.8,5:4.8}, opomba:"mesec priklopa: obračunana minimalna moč" },
    "2026-07": { racun:"IR33027039", obdobje:"1.7.-31.7.", kwh:495, osnova:48.62, ddv:10.70, skupaj:59.32,
                 energija:14.46, omreznina:24.22, prispevki:7.21, trosarina:0.76, nadomestilo:1.97,
                 bloki:{2:79,3:291,4:125,5:0}, moc:{2:8.7,3:18.6,4:18.6,5:18.6} },
    "2026-08": { racun:"IR33344376", obdobje:"1.8.-31.8.", kwh:920, osnova:98.00, ddv:21.56, skupaj:119.56,
                 energija:36.18, omreznina:43.15, prispevki:15.29, trosarina:1.41, nadomestilo:1.97,
                 bloki:{2:139,3:585,4:191,5:5}, moc:{2:18.6,3:20.6,4:20.6,5:20.6} },
  });

  // izračunamo tekoči mesec in prejšnjega (podatki v Moj Elektro zamujajo ~1 dan)
  const now = ljParts(Date.now());

  // ---- KDAJ SO PODATKI ZA VČERAJ NA VOLJO? ----
  // Poceni preverba enega dneva. Zabeležimo zadnji čas, ko jih še ni bilo, in prvi čas, ko so bili
  // popolni. Iz tega se v nekaj dneh vidi, ob kateri uri distributer objavi podatke.
  const yS = ljMidnight(now.getFullYear(), now.getMonth(), now.getDate()-1);
  const yE = ljMidnight(now.getFullYear(), now.getMonth(), now.getDate());
  const yKey = (() => { const d = ljParts(yS); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();
  const shiftP = store.oznakaZamik != null ? store.oznakaZamik : 9e5;
  const probe = await mojElektro(RT_ENERGY, yS, yE, log);
  let nProbe = 0; probe.forEach((v, t) => { const st = t - shiftP; if (st >= yS && st < yE) nProbe++; });
  const nExp = Math.round((yE - yS) / 9e5);           // 96, ob prehodu na poletni/zimski čas 92 ali 100
  const popoln = nProbe >= nExp;
  store.dostopnost = store.dostopnost || {};
  const zd = store.dostopnost[yKey] = store.dostopnost[yKey] || {};
  const zdaj = new Date(Date.now()).toISOString();
  if (popoln){ if (!zd.naVoljo) zd.naVoljo = zdaj; }
  else { zd.niBilo = zdaj; zd.delno = nProbe; }
  // obdržimo zadnjih 45 dni
  Object.keys(store.dostopnost).sort().slice(0, -45).forEach(k => delete store.dostopnost[k]);
  log.push(`podatki za ${yKey}: ${nProbe}/${nExp} četrtur ${popoln ? "- popolni" : "- še niso popolni"}`);

  // Če je bil včerajšnji dan že obdelan, novega ni: končamo brez klicev in brez zapisa.
  if (popoln && store.zadnjiDan === yKey && zd.naVoljo !== zdaj){
    log.push("včerajšnji dan je že obdelan, ni sprememb");
    log.forEach(l => console.log("  " + l)); return;
  }
  if (!popoln){
    // zapišemo le čas preverbe (za ugotavljanje ure objave), izračuna pa ne poganjamo
    store.posodobljeno = store.posodobljeno || zdaj;
    fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
    log.forEach(l => console.log("  " + l)); return;
  }
  const months = [];
  // od julija 2026: junij (mesec priklopa) je bil obračunan z minimalno močjo, ne z izmerjeno
  for (let d = new Date(2026, 6, 1); d <= now; d = new Date(d.getFullYear(), d.getMonth()+1, 1))
    months.push([d.getFullYear(), d.getMonth()]);
  const curKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const pmD = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const prevKey = `${pmD.getFullYear()}-${String(pmD.getMonth()+1).padStart(2,"0")}`;
  const podatki = [];
  for (const [y, m] of months){
    const key = `${y}-${String(m+1).padStart(2,"0")}`;
    const old = store.izracuni[key];
    // zaključen mesec s popolnimi podatki ostane, tekoči in prejšnji se vedno osvežita,
    // meseci z računom pa se vedno preberejo, ker služijo za določitev oznake intervala
    if (old && old.pokrito >= 0.999 && key !== curKey && key !== prevKey && (store.oznakaZamik != null || !store.racuni[key])) continue;
    const from = ljMidnight(y, m, 1), to = Math.min(ljMidnight(y, m+1, 1), Date.now());
    const [en, pw, pr] = await Promise.all([
      mojElektro(RT_ENERGY, from, to, log), mojElektro(RT_POWER, from, to, log), sipx(from, to, log) ]);
    podatki.push({ y, m, key, en, pw, pr });
  }
  // OZNAKA INTERVALA: ali 15-min vrednost nosi začetek ali konec intervala? Ne ugibamo, ampak
  // izberemo tisto, pri kateri se poraba po blokih ujema z DEJANSKIMI računi.
  let shift = store.oznakaZamik;
  const zRacunom = podatki.filter(p => store.racuni[p.key] && store.racuni[p.key].bloki);
  if (zRacunom.length){
    const napaka = sh => zRacunom.reduce((acc, p) => {
      const r = izracunaj(p.y, p.m, p.en, p.pw, p.pr, sh), bl = store.racuni[p.key].bloki;
      return acc + Object.keys(bl).reduce((a,b)=>a+Math.abs(Math.round(r.bloki[b]||0)-bl[b]),0); }, 0);
    const eKonec = napaka(9e5), eZacetek = napaka(0);
    shift = eKonec <= eZacetek ? 9e5 : 0;
    log.push(`oznaka intervala: ${shift?"KONEC":"ZAČETEK"} (odstopanje blokov od računov: konec ${eKonec} kWh, začetek ${eZacetek} kWh)`);
    store.oznakaZamik = shift;
  }
  if (shift == null){ shift = 9e5; log.push("oznaka intervala: privzeto KONEC (ni računa za preverjanje)"); }

  for (const p of podatki){
    const res = izracunaj(p.y, p.m, p.en, p.pw, p.pr, shift);
    if (!res.stMeritev){ log.push(`${p.key}: v Moj Elektro še ni meritev za ta mesec, preskočeno`); continue; }
    res.posodobljeno = new Date().toISOString();
    store.izracuni[res.mesec] = res;
    const rac = store.racuni[res.mesec];
    log.push(`${res.mesec}: ${res.kwh} kWh, izračun ${res.skupaj} EUR`+
      (rac ? ` | RAČUN ${rac.skupaj} EUR, razlika ${(res.skupaj-rac.skupaj).toFixed(2)} EUR` : ` (pokrito ${(res.pokrito*100).toFixed(0)} %)`)+
      ` | moč ${JSON.stringify(res.moc)}`);
  }
  store.zadnjiDan = yKey;
  store.posodobljeno = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  log.forEach(l => console.log("  " + l));
})().catch(e => { console.error("NAPAKA:", e.message); process.exit(1); });

module.exports = { izracunaj };
