#!/usr/bin/env node
/*
 * Ensayo reproducible de calibración fuera de muestra.
 *
 * Calcula correcciones aditivas con el bloque anterior a --holdout-from y las
 * evalúa en el bloque posterior. Nunca modifica feeds, baremo ni archivos fuente.
 * La dirección usada para estratificar es la prevista, disponible al emitir el
 * pronóstico; usar la dirección observada introduciría información futura.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics, joinExact, loadFiles } from './analizar-rachas.mjs';

const DIR=dirname(fileURLToPath(import.meta.url));

function round(value,digits=2){
  if(!Number.isFinite(value)) return null;
  const p=10**digits;
  return Math.round(value*p)/p;
}

export function directionSector(value){
  if(value===null || value===undefined || value==='') return null;
  const degrees=Number(value);
  if(!Number.isFinite(degrees)) return null;
  const normalized=((degrees%360)+360)%360;
  const names=['N','NE','E','SE','S','SO','O','NO'];
  return names[Math.floor((normalized+22.5)/45)%8];
}

export function splitTemporal(pairs,holdoutFrom){
  const date=String(holdoutFrom||'');
  const parsed=new Date(`${date}T00:00:00.000Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
     !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date){
    throw new Error('--holdout-from debe usar YYYY-MM-DD');
  }
  const cutoff=parsed.getTime();
  return {
    training:pairs.filter(pair=>Date.parse(pair.valid_time_utc)<cutoff),
    holdout:pairs.filter(pair=>Date.parse(pair.valid_time_utc)>=cutoff)
  };
}

function correctedPairs(pairs,correction){
  return pairs.map(pair=>({
    ...pair,
    forecast:{
      ...pair.forecast,
      wind_gust_10m_kmh:Math.max(0,Number(pair.forecast.wind_gust_10m_kmh)+correction)
    }
  }));
}

export function evaluateShadow(training,holdout){
  const trainingMetrics=computeMetrics(training);
  const holdoutBefore=computeMetrics(holdout);
  if(!training.length || !holdout.length){
    return {
      training:trainingMetrics,
      holdout_before:holdoutBefore,
      additive_correction_kmh:null,
      holdout_after:{n:0,days:0},
      comparable:false
    };
  }
  const correction=round(-trainingMetrics.gust.bias_kmh,2);
  return {
    training:trainingMetrics,
    holdout_before:holdoutBefore,
    additive_correction_kmh:correction,
    holdout_after:computeMetrics(correctedPairs(holdout,correction)),
    comparable:true
  };
}

export function shadowReport(pairs,{holdoutFrom}={}){
  splitTemporal([],holdoutFrom);
  const groups=new Map();
  const add=(key,label,pair)=>{
    if(!groups.has(key)) groups.set(key,{label,pairs:[]});
    groups.get(key).pairs.push(pair);
  };
  for(const pair of pairs){
    const base=`${pair.provider}/${pair.model_selection}|${pair.station.id}|L${pair.nominal_lead_hours}`;
    const common={
      provider:pair.provider,
      model_selection:pair.model_selection,
      station:pair.station,
      nominal_lead_hours:pair.nominal_lead_hours
    };
    add(`station|${base}`,{scope:'station_horizon',...common},pair);
    const sector=directionSector(pair.forecast?.wind_direction_deg);
    if(sector) add(`direction|${base}|${sector}`,{
      scope:'station_horizon_direction',
      ...common,
      forecast_direction_sector:sector
    },pair);
  }
  return [...groups.values()].map(group=>{
    const {training,holdout}=splitTemporal(group.pairs,holdoutFrom);
    return {...group.label,...evaluateShadow(training,holdout)};
  }).sort((a,b)=>
    a.scope.localeCompare(b.scope) ||
    String(a.station.id).localeCompare(String(b.station.id)) ||
    a.nominal_lead_hours-b.nominal_lead_hours ||
    String(a.forecast_direction_sector||'').localeCompare(String(b.forecast_direction_sector||''))
  );
}

function defaultFiles(){
  return readdirSync(DIR)
    .filter(file=>/^viento_validacion_v2_\d{4}-\d{2}\.jsonl$/.test(file))
    .sort()
    .map(file=>join(DIR,file));
}

function option(args,name){
  const index=args.indexOf(name);
  if(index<0) return null;
  if(!args[index+1] || args[index+1].startsWith('--')) throw new Error(`Falta valor para ${name}`);
  return args[index+1];
}

function cli(args){
  const holdoutFrom=option(args,'--holdout-from');
  if(!holdoutFrom) throw new Error('Indique --holdout-from YYYY-MM-DD');
  const json=args.includes('--json');
  const valued=new Set(['--holdout-from']);
  const files=[];
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(valued.has(arg)){index++;continue;}
    if(arg==='--json') continue;
    if(arg.startsWith('--')) throw new Error(`Argumento no reconocido: ${arg}`);
    files.push(resolve(arg));
  }
  const selected=files.length?files:defaultFiles();
  if(!selected.length){
    console.log('Sin archivos viento_validacion_v2_*.jsonl todavía.');
    return;
  }
  const pairs=joinExact(loadFiles(selected));
  const groups=shadowReport(pairs,{holdoutFrom});
  const result={
    schema_version:1,
    kind:'shadow_calibration_experiment',
    review_only:true,
    holdout_from_utc:`${holdoutFrom}T00:00:00.000Z`,
    files:selected,
    pairs:pairs.length,
    groups
  };
  if(json){console.log(JSON.stringify(result,null,2));return;}
  console.log('── Calibración en sombra · sin cambios de producto ──');
  console.log(`  Corte temporal: ${holdoutFrom} UTC · pares: ${pairs.length}`);
  console.log('  La corrección se aprende antes del corte y solo se evalúa después.');
  console.log('  Ningún resultado autoriza por sí solo a modificar feeds o baremo.\n');
  for(const row of groups.filter(group=>group.scope==='station_horizon')){
    console.log(`  ${row.station.label} · ${row.nominal_lead_hours} h`);
    if(!row.comparable){
      console.log(`    sin comparación: entrenamiento=${row.training.n} · comprobación=${row.holdout_before.n}`);
      continue;
    }
    console.log(`    n=${row.training.n}/${row.holdout_before.n} · ajuste ensayado=${row.additive_correction_kmh} km/h`);
    console.log(`    MAE ${row.holdout_before.gust.mae_kmh} → ${row.holdout_after.gust.mae_kmh} · tramo ${row.holdout_before.gust_bands.exact_rate} → ${row.holdout_after.gust_bands.exact_rate}`);
  }
}

const isMain=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  try{cli(process.argv.slice(2));}
  catch(error){console.error('✗ calibración en sombra abortada:',error.message);process.exit(1);}
}
