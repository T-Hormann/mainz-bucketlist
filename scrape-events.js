#!/usr/bin/env node
/*
 * Agraffen App – Event-Scraper
 * Holt Feste & Winzer-Events (keine Konzerte) aus dem Rhein-Selz-Weinfestkalender
 * (server-seitig gerendert, gut parsebar), filtert, merged mit dem bestehenden
 * kuratierten events.json und schreibt das Ergebnis zurück.
 *
 * Sicherheitsnetz: Wenn nichts Sinnvolles gefunden wird, bleibt events.json
 * unverändert – die kuratierte Liste geht also nie verloren.
 *
 * Läuft ohne npm-Abhängigkeiten (Node 18+, globales fetch).
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "events.json");
const SOURCES = [
  "https://www.tourismus-rhein-selz.de/weinfeste",
  "https://www.tourismus-rhein-selz.de/weinfeste/1",
  "https://www.tourismus-rhein-selz.de/weinfeste/2"
];

// Konzerte & Nicht-Feste raus
const EXCLUDE = /(konzert|live[- ]?musik|\bband\b|paddy|theater|\bkino\b|comedy|lesung|gottesdienst|kommunion|\bbbq\b|buffet|\byoga\b|führung durch die katharinenkirche)/i;
// Nur Wein-/Fest-Bezug rein
const INCLUDE = /(fest|hoffest|weinlounge|weinprobe|markt|wanderung|strau|weingut|winzer|\bwein\b|schobbe|sommer|kerb|kellerlabyrinth|vinothek|weinberg|genuss|after ?work)/i;

const MONTHS_AHEAD = 8;

function decode(s){
  return (s||"")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&ndash;|&#8211;/g,"–").replace(/&auml;/g,"ä").replace(/&ouml;/g,"ö")
    .replace(/&uuml;/g,"ü").replace(/&szlig;/g,"ß").trim();
}
function stripTags(s){ return decode((s||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ")); }

function catOf(title){
  const t=title.toLowerCase();
  if(/hoffest/.test(t)) return "Hoffest";
  if(/markt/.test(t)) return "Weinmarkt";
  if(/wanderung/.test(t)) return "Weinwanderung";
  if(/weinprobe|probe/.test(t)) return "Weinprobe";
  if(/lounge|after ?work|schobbe|vinothek/.test(t)) return "Weinlounge";
  if(/kellerlabyrinth|stadt|kultur|museum|führung/.test(t)) return "Stadt & Kultur";
  if(/fest|kerb|weinmarkt/.test(t)) return "Weinfest";
  return "Wein-Event";
}

function parse(html){
  const events=[];
  // Event-Karten hängen an Detail-Links /weinfeste/e-<slug>; Titel steht im <h3>.
  const re=/<h3[^>]*>\s*<a[^>]+href="[^"]*\/weinfeste\/(e-[^"?#]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/gi;
  let m;
  const seen=new Set();
  while((m=re.exec(html))){
    const slug=m[1];
    const title=stripTags(m[2]);
    if(!title || title.length<3) continue;
    if(seen.has(slug)) continue; seen.add(slug);
    // Kartenbereich = ab hier bis zum nächsten h3 (oder 2500 Zeichen)
    const start=m.index;
    const nextH3=html.indexOf("<h3", start+4);
    const seg=html.slice(start, nextH3>0? nextH3 : start+2500);
    const dm=seg.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if(!dm) continue;
    const tm=seg.match(/(\d{1,2}):(\d{2})\s*Uhr/);
    const hh=tm?String(tm[1]).padStart(2,"0"):"15", mm=tm?tm[2]:"00";
    const iso=`${dm[3]}-${dm[2]}-${dm[1]}T${hh}:${mm}:00`;
    // Stadt aus PLZ-Zeile im Kontakt
    const cm=seg.match(/\b\d{5}\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?: [A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+)?)/);
    const city=cm?decode(cm[1]).replace(/\s+(Tel|E-Mail).*/,"").trim():"";
    // Veranstalter/Venue aus erstem <strong>
    const vm=seg.match(/<strong>([^<]{2,80})<\/strong>/i);
    const venue=vm?decode(vm[1]):"";
    events.push({name:title, start:iso, venue, city, cat:catOf(title)});
  }
  return events;
}

function keep(e){
  if(!e.name || !e.start) return false;
  if(EXCLUDE.test(e.name)) return false;
  if(!INCLUDE.test(e.name)) return false;
  return true;
}

async function fetchText(url){
  const r=await fetch(url,{headers:{"User-Agent":"AgraffenBot/1.0 (+github pages)","Accept-Language":"de"}});
  if(!r.ok) throw new Error("HTTP "+r.status+" "+url);
  return await r.text();
}

(async()=>{
  try{
    let scraped=[];
    for(const url of SOURCES){
      try{ const html=await fetchText(url); scraped=scraped.concat(parse(html)); }
      catch(e){ console.error("Quelle fehlgeschlagen:", url, e.message); }
    }
    scraped=scraped.filter(keep);
    console.log("Gescrapte, gefilterte Events:", scraped.length);

    // Bestehendes (kuratiertes) events.json laden
    let existing=[];
    try{ existing=(JSON.parse(fs.readFileSync(OUT,"utf8")).events)||[]; }catch(e){}

    // Zusammenführen (Dedup nach Name+Datum), Vergangenes raus, in die Zukunft begrenzen
    const now=new Date(); now.setHours(0,0,0,0);
    const limit=new Date(now); limit.setMonth(limit.getMonth()+MONTHS_AHEAD);
    const map=new Map();
    const add=e=>{ const k=(e.name||"").toLowerCase().trim()+"|"+(e.start||"").slice(0,10); if(!map.has(k)) map.set(k,e); };
    existing.forEach(add); scraped.forEach(add);

    let merged=[...map.values()].filter(e=>{
      const d=new Date(e.start); return d>=now && d<=limit;
    }).sort((a,b)=>a.start.localeCompare(b.start)).slice(0,40);

    // Sicherheitsnetz: wenn nach dem Merge fast nichts übrig ist, nichts überschreiben
    if(merged.length < 3){
      console.log("Zu wenige Events – events.json bleibt unverändert.");
      return;
    }

    const out={ updated:new Date().toISOString().slice(0,10),
      source:"kuratiert + tourismus-rhein-selz.de (Feste & Winzer, keine Konzerte)",
      events:merged };
    fs.writeFileSync(OUT, JSON.stringify(out,null,2)+"\n");
    console.log("events.json geschrieben:", merged.length, "Events");
  }catch(e){
    console.error("Fehler – events.json bleibt unverändert:", e.message);
    process.exitCode=0;
  }
})();
