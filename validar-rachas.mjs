#!/usr/bin/env node
/*
 * Registro científico prospectivo de viento (esquema v2).
 *
 * No modifica datos_playas.json ni el baremo. Guarda por separado:
 *   - snapshots de la previsión que consume la web (Open-Meteo best_match);
 *   - observaciones horarias de estaciones AEMET.
 *
 * El emparejado se hace después, por estación y hora UTC exactas. Así evitamos
 * comparar una previsión de una hora con la última observación disponible de otra.
 *
 * Salida: viento_validacion_v2_YYYY-MM.jsonl
 * Uso:    node validar-rachas.mjs
 */
import https from 'node:https';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const AEMET_KEY = process.env.AEMET_API_KEY || process.env.AEMET_OPENDATA_KEY || '';
const CAPTURE_EVERY_HOURS = positiveInt(process.env.WIND_VALIDATION_CADENCE_HOURS, 3);
const NOMINAL_LEADS = parseLeadHours(process.env.WIND_VALIDATION_LEADS || '1,6,12,24');

export const STATIONS = Object.freeze([
  { id:'6277C', label:'Adra Faro', sector:'poniente', lat:36.748056, lng:-3.030833 },
  { id:'6293X', label:'Roquetas de Mar - Faro Sabinar', sector:'poniente', lat:36.686940, lng:-2.701667 },
  { id:'6325O', label:'Almería Aeropuerto', sector:'bahia-almeria', lat:36.846344, lng:-2.356931 },
  { id:'6329X', label:'Cabo de Gata Faro', sector:'cabo-de-gata', lat:36.721945, lng:-2.193056 },
  { id:'6332Y', label:'Carboneras - Faro Mesa Roldán', sector:'levante', lat:36.942222, lng:-1.906944 },
  { id:'6340X', label:'Garrucha Puerto', sector:'levante', lat:37.169278, lng:-1.828511 }
]);

const tls12Agent = new https.Agent({
  keepAlive:true,
  maxSockets:2,
  minVersion:'TLSv1.2',
  maxVersion:'TLSv1.2'
});

function positiveInt(value, fallback){
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseLeadHours(value){
  const leads = String(value)
    .split(',')
    .map(x => Number(x.trim()))
    .filter(x => Number.isInteger(x) && x > 0 && x <= 168);
  return [...new Set(leads)].sort((a,b) => a-b);
}

function round(value, digits=1){
  if(value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if(!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n*p)/p;
}

function isoHour(date){
  const d = new Date(date);
  d.setUTCMinutes(0,0,0);
  return d.toISOString();
}

function nextUtcHour(date){
  const d = new Date(date);
  d.setUTCMinutes(0,0,0);
  d.setUTCHours(d.getUTCHours()+1);
  return d;
}

function captureSlot(date){
  const d = new Date(date);
  d.setUTCSeconds(0,0);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30);
  return d.toISOString();
}

export function normalizeUtc(value){
  if(!value) return null;
  const raw = String(value).trim();
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : raw+'Z';
  const d = new Date(withZone);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function getRaw(url, { agent, accept='application/json', depth=0 }={}){
  return new Promise((resolve,reject)=>{
    const req = https.get(url, {
      agent,
      timeout:20000,
      headers:{
        'user-agent':'playasdealmeria.es validacion-viento/2.0',
        accept
      }
    }, res=>{
      const loc = res.headers.location;
      if(res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 3){
        res.resume();
        resolve(getRaw(new URL(loc,url).toString(), {agent,accept,depth:depth+1}));
        return;
      }
      const chunks=[];
      res.on('data', c=>chunks.push(c));
      res.on('end', ()=>resolve({
        ok:res.statusCode >= 200 && res.statusCode < 300,
        status:res.statusCode,
        buffer:Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });
    req.on('timeout', ()=>req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function getJSON(url, options){
  const r = await getRaw(url, options);
  if(!r.ok){
    const safe = String(url).replace(/api_key=[^&]+/i,'api_key=***');
    throw new Error('HTTP '+r.status+' '+safe);
  }
  return JSON.parse(r.buffer.toString('utf8'));
}

export function observationRecords(station, rows, capturedAt){
  if(!station || !Array.isArray(rows)) return [];
  const out=[];
  for(const row of rows){
    if(!row || String(row.idema || station.id) !== station.id) continue;
    const valid = normalizeUtc(row.fint);
    const wind = round(row.vv === null || row.vv === undefined || row.vv === ''
      ? null : Number(row.vv)*3.6);
    const gust = round(row.vmax === null || row.vmax === undefined || row.vmax === ''
      ? null : Number(row.vmax)*3.6);
    if(!valid || wind === null || gust === null) continue;
    out.push({
      schema_version:2,
      kind:'observation',
      record_id:`observation:aemet:${station.id}:${valid}`,
      provider:'aemet_opendata',
      station:{...station},
      captured_at:capturedAt,
      valid_time_utc:valid,
      variables:{
        wind_speed_10m_kmh:wind,
        wind_gust_10m_kmh:gust,
        wind_direction_deg:round(row.dv,0)
      },
      source_fields:{ wind_speed:'vv', wind_gust:'vmax', wind_direction:'dv' },
      quality:{
        stage:'provisional_realtime',
        note:'Observación automática reciente; no equivale a una serie climatológica depurada.'
      }
    });
  }
  return out;
}

export function forecastRecords(stations, payload, capturedAt, nominalLeads=NOMINAL_LEADS){
  const responses = Array.isArray(payload) ? payload : [payload];
  if(responses.length !== stations.length){
    throw new Error(`Open-Meteo devolvió ${responses.length} ubicaciones; se esperaban ${stations.length}`);
  }
  const captured = new Date(capturedAt);
  const base = nextUtcHour(captured);
  const slot = captureSlot(captured);
  const out=[];
  for(let s=0;s<stations.length;s++){
    const station=stations[s], data=responses[s] || {}, hourly=data.hourly || {};
    if(!Array.isArray(hourly.time)) continue;
    for(const nominalLead of nominalLeads){
      const validDate = new Date(base.getTime()+(nominalLead-1)*3600000);
      const valid = validDate.toISOString();
      const apiTime = valid.slice(0,16);
      const i = hourly.time.indexOf(apiTime);
      if(i < 0) continue;
      const wind = round(hourly.wind_speed_10m?.[i]);
      const gust = round(hourly.wind_gusts_10m?.[i]);
      const direction = round(hourly.wind_direction_10m?.[i],0);
      if(wind === null || gust === null) continue;
      out.push({
        schema_version:2,
        kind:'forecast',
        record_id:`forecast:open_meteo_best_match:${station.id}:${slot}:L${nominalLead}`,
        provider:'open_meteo',
        model_selection:'best_match',
        model_run_utc:null,
        station:{...station},
        captured_at:capturedAt,
        capture_slot_utc:slot,
        valid_time_utc:valid,
        nominal_lead_hours:nominalLead,
        actual_lead_hours:round((validDate-captured)/3600000,3),
        variables:{
          wind_speed_10m_kmh:wind,
          wind_gust_10m_kmh:gust,
          wind_direction_deg:direction
        },
        grid:{
          latitude:round(data.latitude,6),
          longitude:round(data.longitude,6),
          elevation_m:round(data.elevation,1),
          timezone:data.timezone || 'GMT'
        },
        semantics:{
          type:'public_best_match_snapshot',
          note:'Snapshot de la serie que entregaba Forecast API al capturarla; no se atribuye a una pasada concreta.'
        }
      });
    }
  }
  return out;
}

export function parseArchive(raw, fileLabel='archivo'){
  const rows=[];
  const ids=new Set();
  const lines=String(raw || '').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const text=lines[i].trim();
    if(!text) continue;
    let row;
    try{ row=JSON.parse(text); }
    catch(e){ throw new Error(`${fileLabel}:${i+1}: JSON inválido: ${e.message}`); }
    if(row?.schema_version !== 2 || !row.record_id || !['forecast','observation'].includes(row.kind)){
      throw new Error(`${fileLabel}:${i+1}: registro v2 inválido`);
    }
    if(ids.has(row.record_id)) throw new Error(`${fileLabel}:${i+1}: record_id duplicado`);
    ids.add(row.record_id);
    rows.push(row);
  }
  return rows;
}

export function mergeArchive(existing, incoming){
  const out=[...existing], ids=new Set(existing.map(x=>x.record_id));
  for(const row of incoming){
    if(!row?.record_id || ids.has(row.record_id)) continue;
    ids.add(row.record_id);
    out.push(row);
  }
  out.sort((a,b)=>
    String(a.captured_at).localeCompare(String(b.captured_at)) ||
    String(a.record_id).localeCompare(String(b.record_id))
  );
  return out;
}

function writeArchiveAtomic(file, incoming){
  const existing = existsSync(file) ? parseArchive(readFileSync(file,'utf8'),file) : [];
  const merged = mergeArchive(existing,incoming);
  if(merged.length === existing.length){
    console.log('· validación viento: sin registros nuevos');
    return 0;
  }
  const tmp=file+'.tmp-'+process.pid;
  writeFileSync(tmp, merged.map(x=>JSON.stringify(x)).join('\n')+'\n', 'utf8');
  renameSync(tmp,file);
  return merged.length-existing.length;
}

async function fetchAemetStation(station, capturedAt){
  const metaURL=`https://opendata.aemet.es/opendata/api/observacion/convencional/datos/estacion/${station.id}?api_key=${AEMET_KEY}`;
  const meta=await getJSON(metaURL,{agent:tls12Agent});
  if(!meta?.datos) throw new Error('meta sin URL de datos (estado '+(meta?.estado ?? '?')+')');
  const rows=await getJSON(meta.datos,{agent:tls12Agent});
  return observationRecords(station,rows,capturedAt);
}

async function fetchForecasts(capturedAt){
  const query=new URLSearchParams({
    latitude:STATIONS.map(x=>x.lat).join(','),
    longitude:STATIONS.map(x=>x.lng).join(','),
    hourly:'wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    timezone:'GMT',
    forecast_hours:String(Math.max(...NOMINAL_LEADS)+2),
    wind_speed_unit:'kmh'
  });
  const payload=await getJSON('https://api.open-meteo.com/v1/forecast?'+query);
  return forecastRecords(STATIONS,payload,capturedAt,NOMINAL_LEADS);
}

async function main(){
  if(!AEMET_KEY){
    console.warn('· validación viento: sin AEMET_API_KEY → salto no crítico.');
    return;
  }
  const now=new Date();
  const capturedAt=now.toISOString();
  const records=[];
  const notes=[];

  if(now.getUTCHours() % CAPTURE_EVERY_HOURS === 0){
    try{ records.push(...await fetchForecasts(capturedAt)); }
    catch(e){ notes.push('Open-Meteo: '+e.message); }
  }else{
    notes.push(`previsión: fuera de cadencia (${CAPTURE_EVERY_HOURS} h)`);
  }

  for(const station of STATIONS){
    try{ records.push(...await fetchAemetStation(station,capturedAt)); }
    catch(e){ notes.push(`${station.id}: ${e.message}`); }
  }

  const month=capturedAt.slice(0,7);
  const out=join(DIR,`viento_validacion_v2_${month}.jsonl`);
  const added=writeArchiveAtomic(out,records);
  console.log(`· validación viento v2: ${added} nuevos · ${records.filter(x=>x.kind==='forecast').length} previsiones · ${records.filter(x=>x.kind==='observation').length} observaciones`);
  for(const note of notes) console.log('  · '+note);
}

if(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])){
  main().catch(e=>console.warn('· validación viento: fallo no crítico:',e.message));
}
