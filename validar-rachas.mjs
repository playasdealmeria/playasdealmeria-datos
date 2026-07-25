#!/usr/bin/env node
/* validar-rachas.mjs  (repo playasdealmeria-datos)
 *
 * PROPÓSITO: verificar el modelo de rachas de Open-Meteo contra ESTACIÓN REAL antes de
 * publicar rachas en la cabecera. Cada ejecución empareja, para el aeropuerto de Almería:
 *   · Open-Meteo (lo que MOSTRARÍAMOS): viento sostenido + racha previstos para ESTA hora.
 *   · AEMET estación 6325O (Almería Aeropuerto), observación REAL: `vv` (sostenido, m/s) y
 *     `vmax` (racha, m/s) → ×3,6 a km/h.
 * y añade una línea a `rachas_validacion_YYYY-MM.jsonl`. Tras unos días, `analizar-rachas.mjs`
 * dice si Open-Meteo exagera las rachas (sesgo, RMSE, «cried wolf») o si el 6-7× es solo el
 * artefacto de agregación por tramos (datos v91.14). Mismo patrón que el archivo de banderas
 * (datos v91.12): instrumentar ahora, decidir con datos.
 *
 * Reutiliza el agente TLS 1.2 de AEMET (datos v91.9/11). NO toca el build principal ni
 * `datos_playas.json`; fallo NO crítico (avisa y sale 0). Requiere AEMET_API_KEY (la misma
 * clave OpenData que ya usa el repo para avisos).
 *
 * Uso (en el workflow, tras build-data, o a mano):  node validar-rachas.mjs
 *   AIRPORT_LAT/AIRPORT_LNG opcionales (por defecto Almería aeropuerto).
 */
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const AEMET_KEY = process.env.AEMET_API_KEY || process.env.AEMET_OPENDATA_KEY || '';
const STATION = process.env.AEMET_STATION || '6325O';        // Almería Aeropuerto
const LAT = Number(process.env.AIRPORT_LAT || 36.8439);
const LNG = Number(process.env.AIRPORT_LNG || -2.3701);
const TZ = 'Europe/Madrid';

// ───────────────────────── helpers de red (self-contained) ─────────────────────────
const agent = new https.Agent({ keepAlive:true, maxSockets:1, minVersion:'TLSv1.2', maxVersion:'TLSv1.2' });
function getRaw(url, accept, depth){ depth=depth||0; return new Promise((resolve,reject)=>{
  const req=https.get(url,{agent,timeout:20000,headers:{'user-agent':'playasdealmeria.es validar-rachas/1.0','accept':accept||'*/*'}},res=>{
    const loc=res.headers.location;
    if(res.statusCode>=300&&res.statusCode<400&&loc&&depth<3){res.resume();resolve(getRaw(new URL(loc,url).toString(),accept,depth+1));return;}
    const ch=[]; res.on('data',c=>ch.push(c)); res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,buffer:Buffer.concat(ch)})); res.on('error',reject);
  }); req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',reject); }); }
async function getJSON(url){ const r=await getRaw(url,'application/json'); if(!r.ok) throw new Error('HTTP '+r.status+' '+url.replace(/api_key=[^&]+/,'api_key=***')); return JSON.parse(r.buffer.toString('utf8')); }

// ───────────────────────── PARSEO (puro, unit-testable) ─────────────────────────
// Open-Meteo: dado el hourly y una hora ISO local, saca {wind,gust} de esa hora.
export function pickOpenMeteoHour(hourly, isoHour){
  if(!hourly||!Array.isArray(hourly.time)) return null;
  const i = hourly.time.indexOf(isoHour);
  if(i<0) return null;
  const wind = hourly.wind_speed_10m?.[i], gust = hourly.wind_gusts_10m?.[i];
  if(wind==null||gust==null) return null;
  return { wind: Math.round(wind), gust: Math.round(gust) };
}
// AEMET convencional: array de observaciones horarias; coge la ÚLTIMA con vv y vmax.
// vv/vmax vienen en m/s → km/h (×3,6). Devuelve también fint (fecha-hora de la obs).
export function pickAemetLatest(rows){
  if(!Array.isArray(rows)) return null;
  const withWind = rows.filter(r=>r && r.vv!=null && r.vmax!=null);
  if(!withWind.length) return null;
  withWind.sort((a,b)=>String(a.fint||'').localeCompare(String(b.fint||'')));
  const r = withWind[withWind.length-1];
  return { wind: Math.round(Number(r.vv)*3.6), gust: Math.round(Number(r.vmax)*3.6), fint: r.fint||null, dir: r.dv!=null?Math.round(r.dv):null };
}
// La hora ISO local (Madrid) truncada a la hora en punto, formato Open-Meteo "YYYY-MM-DDTHH:00".
export function madridHourISO(d){
  // d: Date. Formateo en TZ Madrid sin dependencias.
  const p = new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
  // 'sv-SE' da "YYYY-MM-DD HH:MM" → a "YYYY-MM-DDTHH:00"
  return p.replace(' ','T').slice(0,13)+':00';
}

// ───────────────────────── main ─────────────────────────
async function main(){
  if(!AEMET_KEY){ console.warn('· validar-rachas: sin AEMET_API_KEY → salto (no crítico).'); return; }
  const now = new Date();
  const isoHour = madridHourISO(now);

  let om=null, obs=null, note=[];
  try{
    const omURL = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&hourly=wind_speed_10m,wind_gusts_10m&timezone=${encodeURIComponent(TZ)}&forecast_days=1&wind_speed_unit=kmh`;
    const omJSON = await getJSON(omURL);
    om = pickOpenMeteoHour(omJSON.hourly, isoHour);
    if(!om) note.push('open-meteo sin la hora '+isoHour);
  }catch(e){ note.push('open-meteo: '+e.message); }

  try{
    // AEMET OpenData es en dos pasos: la 1ª llamada devuelve {datos:url}, la 2ª trae el array.
    const metaURL = `https://opendata.aemet.es/opendata/api/observacion/convencional/datos/estacion/${STATION}?api_key=${AEMET_KEY}`;
    const meta = await getJSON(metaURL);
    if(meta && meta.datos){ const rows = await getJSON(meta.datos); obs = pickAemetLatest(rows); }
    else note.push('aemet meta sin datos (estado '+(meta&&meta.estado)+')');
    if(!obs) note.push('aemet sin obs de viento');
  }catch(e){ note.push('aemet: '+e.message); }

  const rec = {
    ts: now.toISOString(),
    hourLocal: isoHour,
    om_wind: om?om.wind:null, om_gust: om?om.gust:null,
    om_ratio: (om&&om.wind>0)? Number((om.gust/om.wind).toFixed(2)) : null,
    obs_wind: obs?obs.wind:null, obs_gust: obs?obs.gust:null,
    obs_ratio: (obs&&obs.wind>0)? Number((obs.gust/obs.wind).toFixed(2)) : null,
    obs_fint: obs?obs.fint:null,
    gust_err: (om&&obs)? (om.gust-obs.gust) : null,   // + = Open-Meteo sobre-predice la racha
    note: note.length?note.join('; '):undefined
  };
  const month = isoHour.slice(0,7);
  const out = join(DIR, `rachas_validacion_${month}.jsonl`);
  appendFileSync(out, JSON.stringify(rec)+'\n');
  console.log('· validar-rachas', isoHour, '· OM', rec.om_wind+'/'+rec.om_gust, '· REAL', rec.obs_wind+'/'+rec.obs_gust, '· err racha', rec.gust_err, note.length?('· '+rec.note):'');
}

// Solo corre main si se ejecuta directamente (no al importar para tests).
if(process.argv[1] && process.argv[1].endsWith('validar-rachas.mjs')){
  main().catch(e=>{ console.warn('· validar-rachas: fallo no crítico:', e.message); });
}
