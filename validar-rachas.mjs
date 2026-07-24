#!/usr/bin/env node
/* validar-rachas.mjs  (repo playasdealmeria-datos)
 *
 * PROPOSITO: verificar el modelo de viento/rachas de Open-Meteo contra ESTACION REAL de AEMET,
 * ahora en VARIAS estaciones costeras por zona (Poniente y Levante), para decidir con datos si
 * el sesgo de Open-Meteo es distinto por zona y, por tanto, si merece la pena anclar el viento
 * por zona en vez de con una sola estacion. Es un registro INERTE: no toca el build principal ni
 * datos_playas.json, solo anade lineas a rachas_validacion_YYYY-MM.jsonl. Fallo NO critico.
 *
 * Para cada estacion empareja, en la hora en punto local:
 *   . Open-Meteo (lo que MOSTRARIAMOS): viento sostenido + racha en las coordenadas de la estacion.
 *   . AEMET observacion REAL: vv (sostenido, m/s) y vmax (racha, m/s) -> x3,6 a km/h.
 * y calcula el error de Open-Meteo (om - obs). Negativo = Open-Meteo se queda corto.
 *
 * Reutiliza el agente TLS 1.2 de AEMET. Requiere AEMET_API_KEY (la misma clave OpenData del repo).
 * Codigos idema con letra final dudosa (Adra, Carboneras) llevan alternativa: se prueba una y otra.
 * Uso (en el workflow, tras build-data, o a mano):  node validar-rachas.mjs
 */
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const AEMET_KEY = process.env.AEMET_API_KEY || process.env.AEMET_OPENDATA_KEY || '';
const TZ = 'Europe/Madrid';

// Estaciones costeras de AEMET con viento, por zona. lat/lng son de respaldo: si la observacion
// de AEMET trae sus propias coordenadas, se usan esas (mas exactas). Adra y Carboneras llevan la
// letra de control alternativa por si la primera no responde.
const STATIONS = [
  { codes:['6325O'],          zone:'poniente', label:'Almeria Aeropuerto',      lat:36.8439, lng:-2.3701 },
  { codes:['6277B','6277C'],  zone:'poniente', label:'Adra Faro',               lat:36.7490, lng:-3.0180 },
  { codes:['6293X'],          zone:'poniente', label:'Roquetas Faro Sabinar',   lat:36.6930, lng:-2.6870 },
  { codes:['6291B'],          zone:'poniente', label:'El Ejido',                lat:36.7000, lng:-2.7900 },
  { codes:['6329X'],          zone:'levante',  label:'Cabo de Gata Faro',       lat:36.7200, lng:-2.1900 },
  { codes:['6332X','6332Y'],  zone:'levante',  label:'Carboneras Mesa Roldan',  lat:36.9620, lng:-1.8970 },
  { codes:['6340X'],          zone:'levante',  label:'Garrucha Puerto',         lat:37.1780, lng:-1.8210 },
];

// ──────────────────────────── helpers de red (self-contained) ────────────────────────────
const agent = new https.Agent({ keepAlive:true, maxSockets:1, minVersion:'TLSv1.2', maxVersion:'TLSv1.2' });
function getRaw(url, accept, depth){ depth=depth||0; return new Promise((resolve,reject)=>{
  const req=https.get(url,{agent,timeout:20000,headers:{'user-agent':'playasdealmeria.es validar-rachas/2.0','accept':accept||'*/*'}},res=>{
    const loc=res.headers.location;
    if(res.statusCode>=300&&res.statusCode<400&&loc&&depth<3){res.resume();resolve(getRaw(new URL(loc,url).toString(),accept,depth+1));return;}
    const ch=[]; res.on('data',c=>ch.push(c)); res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,buffer:Buffer.concat(ch)})); res.on('error',reject);
  }); req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',reject); }); }
async function getJSON(url){ const r=await getRaw(url,'application/json'); if(!r.ok) throw new Error('HTTP '+r.status+' '+url.replace(/api_key=[^&]+/,'api_key=***')); return JSON.parse(r.buffer.toString('utf8')); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ──────────────────────────── PARSEO (puro, unit-testable) ────────────────────────────
// Open-Meteo: dado el hourly y una hora ISO local, saca {wind,gust} de esa hora.
export function pickOpenMeteoHour(hourly, isoHour){
  if(!hourly||!Array.isArray(hourly.time)) return null;
  const i = hourly.time.indexOf(isoHour);
  if(i<0) return null;
  const wind = hourly.wind_speed_10m?.[i], gust = hourly.wind_gusts_10m?.[i];
  if(wind==null||gust==null) return null;
  return { wind: Math.round(wind), gust: Math.round(gust) };
}
// AEMET convencional: array de observaciones horarias; coge la ULTIMA con vv y vmax.
// vv/vmax vienen en m/s -> km/h (x3,6). Devuelve tambien fint, dir y coordenadas/nombre de la estacion.
export function pickAemetLatest(rows){
  if(!Array.isArray(rows)) return null;
  const withWind = rows.filter(r=>r && r.vv!=null && r.vmax!=null);
  if(!withWind.length) return null;
  withWind.sort((a,b)=>String(a.fint||'').localeCompare(String(b.fint||'')));
  const r = withWind[withWind.length-1];
  return { wind: Math.round(Number(r.vv)*3.6), gust: Math.round(Number(r.vmax)*3.6), fint: r.fint||null, dir: r.dv!=null?Math.round(r.dv):null, lat: r.lat!=null?r.lat:null, lon: r.lon!=null?r.lon:null, ubi: r.ubi||null };
}
// Coordenada de AEMET: acepta decimal (numero o string) o DMS "364838N" / "0301048W". null si no se puede.
export function parseAemetCoord(v){
  if(v==null) return null;
  if(typeof v==='number') return Math.abs(v)<=180 ? v : null;
  const s=String(v).trim();
  if(/^-?\d+(\.\d+)?$/.test(s)){ const n=Number(s); return Math.abs(n)<=180 ? n : null; }
  const m=s.match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/i);
  if(m){ let d=(+m[1])+(+m[2])/60+(+m[3])/3600; const h=m[4].toUpperCase(); if(h==='S'||h==='W') d=-d; return d; }
  return null;
}
// La hora ISO local (Madrid) truncada a la hora en punto, formato Open-Meteo "YYYY-MM-DDTHH:00".
export function madridHourISO(d){
  const p = new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
  return p.replace(' ','T').slice(0,13)+':00';
}

function omURLFor(lat,lng){
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=wind_speed_10m,wind_gusts_10m&timezone=${encodeURIComponent(TZ)}&forecast_days=1&wind_speed_unit=kmh`;
}
// Observacion de AEMET para un codigo (dos pasos): {obs, note, code}
async function fetchAemetObs(code){
  try{
    const metaURL = `https://opendata.aemet.es/opendata/api/observacion/convencional/datos/estacion/${code}?api_key=${AEMET_KEY}`;
    const meta = await getJSON(metaURL);
    if(!meta || !meta.datos) return { obs:null, note:'meta sin datos (estado '+(meta&&meta.estado)+')', code };
    const rows = await getJSON(meta.datos);
    const obs = pickAemetLatest(rows);
    return { obs, note: obs?null:'sin obs de viento', code };
  }catch(e){ return { obs:null, note:'aemet: '+e.message, code }; }
}

// ──────────────────────────── main ────────────────────────────
async function main(){
  if(!AEMET_KEY){ console.warn('. validar-rachas: sin AEMET_API_KEY -> salto (no critico).'); return; }
  const now = new Date();
  const isoHour = madridHourISO(now);
  const month = isoHour.slice(0,7);
  const out = join(DIR, `rachas_validacion_${month}.jsonl`);

  for(let si=0; si<STATIONS.length; si++){
    const st = STATIONS[si];
    const note = [];
    let obs=null, usedCode=st.codes[0];

    // AEMET: probar los codigos por orden hasta obtener observacion de viento.
    for(const code of st.codes){
      const r = await fetchAemetObs(code);
      usedCode = r.code;
      if(r.obs){ obs = r.obs; break; }
      if(r.note) note.push(code+': '+r.note);
      await sleep(250);
    }

    // Coordenadas: las de la estacion si vienen y son validas, si no las de respaldo.
    const lat = (obs && parseAemetCoord(obs.lat)) ?? st.lat;
    const lng = (obs && parseAemetCoord(obs.lon)) ?? st.lng;

    // Open-Meteo en la ubicacion de la estacion, misma hora.
    let om=null;
    try{
      const omJSON = await getJSON(omURLFor(lat,lng));
      om = pickOpenMeteoHour(omJSON.hourly, isoHour);
      if(!om) note.push('open-meteo sin la hora '+isoHour);
    }catch(e){ note.push('open-meteo: '+e.message); }

    const rec = {
      ts: now.toISOString(),
      hourLocal: isoHour,
      station: usedCode,
      zone: st.zone,
      label: st.label,
      ubi: obs?obs.ubi:null,
      lat, lng,
      om_wind: om?om.wind:null, om_gust: om?om.gust:null,
      om_ratio: (om&&om.wind>0)? Number((om.gust/om.wind).toFixed(2)) : null,
      obs_wind: obs?obs.wind:null, obs_gust: obs?obs.gust:null,
      obs_ratio: (obs&&obs.wind>0)? Number((obs.gust/obs.wind).toFixed(2)) : null,
      obs_dir: obs?obs.dir:null,
      obs_fint: obs?obs.fint:null,
      wind_err: (om&&obs)? (om.wind-obs.wind) : null,   // negativo = Open-Meteo infravalora el viento
      gust_err: (om&&obs)? (om.gust-obs.gust) : null,   // negativo = Open-Meteo infravalora la racha
      note: note.length?note.join('; '):undefined
    };
    appendFileSync(out, JSON.stringify(rec)+'\n');
    console.log('. validar-rachas', isoHour, st.zone, usedCode, st.label, '. OM', rec.om_wind+'/'+rec.om_gust, '. REAL', rec.obs_wind+'/'+rec.obs_gust, '. err viento/racha', rec.wind_err+'/'+rec.gust_err, note.length?('. '+rec.note):'');
    if(si<STATIONS.length-1) await sleep(300);
  }
}

// Solo corre main si se ejecuta directamente (no al importar para tests).
if(process.argv[1] && process.argv[1].endsWith('validar-rachas.mjs')){
  main().catch(e=>{ console.warn('. validar-rachas: fallo no critico:', e.message); });
}
