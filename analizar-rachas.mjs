#!/usr/bin/env node
/*
 * Analiza exclusivamente el archivo científico v2.
 *
 * Principios:
 *   - emparejado por estación y hora UTC exactas;
 *   - una muestra por estación/modelo/horizonte/hora válida;
 *   - nunca usa una previsión capturada después de la hora que pretende predecir;
 *   - informa cobertura y error, pero no declara automáticamente que un modelo sea
 *     "fiable" ni propone correcciones del baremo.
 *
 * Uso:
 *   node analizar-rachas.mjs [viento_validacion_v2_*.jsonl ...]
 *   node analizar-rachas.mjs --json [archivos ...]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR=dirname(fileURLToPath(import.meta.url));

function finite(value){
  return value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value));
}
function round(value,digits=2){
  if(!Number.isFinite(value)) return null;
  const p=10**digits;
  return Math.round(value*p)/p;
}
function mean(values){ return values.reduce((a,b)=>a+b,0)/values.length; }

export function validateRecord(row,label='registro'){
  if(!row || row.schema_version!==2) throw new Error(label+': schema_version debe ser 2');
  if(!['forecast','observation'].includes(row.kind)) throw new Error(label+': kind inválido');
  if(typeof row.record_id!=='string' || !row.record_id) throw new Error(label+': falta record_id');
  if(!row.station?.id) throw new Error(label+': falta station.id');
  if(!Number.isFinite(Date.parse(row.captured_at))) throw new Error(label+': captured_at inválido');
  if(!Number.isFinite(Date.parse(row.valid_time_utc))) throw new Error(label+': valid_time_utc inválido');
  if(!finite(row.variables?.wind_speed_10m_kmh) || !finite(row.variables?.wind_gust_10m_kmh)){
    throw new Error(label+': faltan viento o racha');
  }
  if(row.kind==='forecast'){
    if(!row.model_selection) throw new Error(label+': falta model_selection');
    if(!finite(row.nominal_lead_hours) || Number(row.nominal_lead_hours)<=0){
      throw new Error(label+': nominal_lead_hours inválido');
    }
  }
  return row;
}

export function parseJsonl(raw,label='archivo'){
  const out=[];
  String(raw||'').split(/\r?\n/).forEach((line,index)=>{
    const text=line.trim();
    if(!text) return;
    let row;
    try{ row=JSON.parse(text); }
    catch(e){ throw new Error(`${label}:${index+1}: JSON inválido: ${e.message}`); }
    out.push(validateRecord(row,`${label}:${index+1}`));
  });
  return out;
}

export function dedupeRecords(rows){
  const byId=new Map();
  for(const row of rows){
    validateRecord(row);
    if(!byId.has(row.record_id)) byId.set(row.record_id,row);
  }
  return [...byId.values()];
}

export function joinExact(rows){
  const clean=dedupeRecords(rows);
  const observations=new Map();
  for(const row of clean){
    if(row.kind!=='observation') continue;
    const key=`${row.station.id}|${row.valid_time_utc}`;
    const previous=observations.get(key);
    if(!previous || row.captured_at<previous.captured_at) observations.set(key,row);
  }

  // Dos ejecuciones dentro de la misma hora pueden apuntar a la misma hora válida.
  // Conservamos la última previsión disponible ANTES del instante válido.
  const forecasts=new Map();
  for(const row of clean){
    if(row.kind!=='forecast') continue;
    if(Date.parse(row.captured_at)>=Date.parse(row.valid_time_utc)) continue;
    const key=[
      row.provider,
      row.model_selection,
      row.station.id,
      row.nominal_lead_hours,
      row.valid_time_utc
    ].join('|');
    const previous=forecasts.get(key);
    if(!previous || row.captured_at>previous.captured_at) forecasts.set(key,row);
  }

  const pairs=[];
  for(const forecast of forecasts.values()){
    const observation=observations.get(`${forecast.station.id}|${forecast.valid_time_utc}`);
    if(!observation) continue;
    pairs.push({
      station:forecast.station,
      provider:forecast.provider,
      model_selection:forecast.model_selection,
      nominal_lead_hours:Number(forecast.nominal_lead_hours),
      captured_at:forecast.captured_at,
      valid_time_utc:forecast.valid_time_utc,
      forecast:forecast.variables,
      observation:observation.variables
    });
  }
  return pairs.sort((a,b)=>
    a.valid_time_utc.localeCompare(b.valid_time_utc) ||
    a.station.id.localeCompare(b.station.id) ||
    a.nominal_lead_hours-b.nominal_lead_hours
  );
}

function variableMetrics(pairs,field){
  const errors=pairs.map(p=>Number(p.forecast[field])-Number(p.observation[field]));
  return {
    bias_kmh:round(mean(errors)),
    mae_kmh:round(mean(errors.map(Math.abs))),
    rmse_kmh:round(Math.sqrt(mean(errors.map(x=>x*x))))
  };
}

export function computeMetrics(pairs){
  if(!pairs.length) return { n:0, days:0 };
  const days=new Set(pairs.map(p=>p.valid_time_utc.slice(0,10)));
  const strongObs=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)>=40).length;
  const strongForecast=pairs.filter(p=>Number(p.forecast.wind_gust_10m_kmh)>=40).length;
  const hits=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)>=40 && Number(p.forecast.wind_gust_10m_kmh)>=40).length;
  const misses=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)>=40 && Number(p.forecast.wind_gust_10m_kmh)<40).length;
  const falseAlarms=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)<40 && Number(p.forecast.wind_gust_10m_kmh)>=40).length;
  const severeMisses=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)>=40 && Number(p.forecast.wind_gust_10m_kmh)<25).length;
  const severeFalseAlarms=pairs.filter(p=>Number(p.observation.wind_gust_10m_kmh)<25 && Number(p.forecast.wind_gust_10m_kmh)>=40).length;
  return {
    n:pairs.length,
    days:days.size,
    first_valid_time:pairs[0].valid_time_utc,
    last_valid_time:pairs[pairs.length-1].valid_time_utc,
    wind:variableMetrics(pairs,'wind_speed_10m_kmh'),
    gust:variableMetrics(pairs,'wind_gust_10m_kmh'),
    events:{
      threshold_kmh:40,
      observed:strongObs,
      forecast:strongForecast,
      hits,
      misses,
      false_alarms:falseAlarms,
      severe_misses_below_25:severeMisses,
      severe_false_alarms_observed_below_25:severeFalseAlarms
    },
    coverage_flags:{
      fewer_than_14_days:days.size<14,
      fewer_than_100_pairs:pairs.length<100,
      fewer_than_10_observed_strong_events:strongObs<10
    }
  };
}

export function groupedReport(pairs){
  const groups=new Map();
  const add=(key,label,pair)=>{
    if(!groups.has(key)) groups.set(key,{label,pairs:[]});
    groups.get(key).pairs.push(pair);
  };
  for(const pair of pairs){
    const base=`${pair.provider}/${pair.model_selection}`;
    add(`model|${base}|L${pair.nominal_lead_hours}`,{
      scope:'model',
      provider:pair.provider,
      model_selection:pair.model_selection,
      nominal_lead_hours:pair.nominal_lead_hours
    },pair);
    add(`station|${base}|${pair.station.id}|L${pair.nominal_lead_hours}`,{
      scope:'station',
      provider:pair.provider,
      model_selection:pair.model_selection,
      station:pair.station,
      nominal_lead_hours:pair.nominal_lead_hours
    },pair);
  }
  return [...groups.values()]
    .map(group=>({...group.label,metrics:computeMetrics(group.pairs)}))
    .sort((a,b)=>
      a.scope.localeCompare(b.scope) ||
      a.nominal_lead_hours-b.nominal_lead_hours ||
      String(a.station?.id||'').localeCompare(String(b.station?.id||''))
    );
}

export function loadFiles(files){
  const rows=[];
  for(const file of files){
    if(!existsSync(file)) throw new Error('No existe: '+file);
    rows.push(...parseJsonl(readFileSync(file,'utf8'),file));
  }
  return rows;
}

function defaultFiles(){
  return readdirSync(DIR)
    .filter(f=>/^viento_validacion_v2_\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map(f=>join(DIR,f));
}

function printHuman(report,pairs,files){
  console.log('── Validación científica de viento · esquema v2 ──');
  console.log(`  Archivos: ${files.length} · pares exactos únicos: ${pairs.length}`);
  console.log('  No se mezclan los rachas_validacion_*.jsonl legacy.');
  console.log('  Estas métricas son descriptivas; no autorizan por sí solas a recalibrar el baremo.\n');
  for(const row of report.filter(x=>x.scope==='model')){
    const m=row.metrics;
    console.log(`  ${row.model_selection} · horizonte nominal ${row.nominal_lead_hours} h`);
    console.log(`    n=${m.n} · días=${m.days} · racha bias=${m.gust.bias_kmh} · MAE=${m.gust.mae_kmh} · RMSE=${m.gust.rmse_kmh} km/h`);
    console.log(`    eventos ≥40: observados=${m.events.observed} · aciertos=${m.events.hits} · fallos=${m.events.misses} · falsas alarmas=${m.events.false_alarms}`);
    const active=Object.entries(m.coverage_flags).filter(([,v])=>v).map(([k])=>k);
    if(active.length) console.log('    cobertura insuficiente: '+active.join(', '));
  }
}

const isMain=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  try{
    const json=process.argv.includes('--json');
    const args=process.argv.slice(2).filter(x=>x!=='--json').map(resolve);
    const files=args.length?args:defaultFiles();
    if(!files.length){
      console.log('Sin archivos viento_validacion_v2_*.jsonl todavía.');
      process.exit(0);
    }
    const rows=loadFiles(files);
    const pairs=joinExact(rows);
    const report=groupedReport(pairs);
    if(json) console.log(JSON.stringify({schema_version:2,files,pairs:pairs.length,groups:report},null,2));
    else printHuman(report,pairs,files);
  }catch(e){
    console.error('✗ análisis abortado:',e.message);
    process.exit(1);
  }
}
