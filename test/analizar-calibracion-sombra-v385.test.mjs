import test from 'node:test';
import assert from 'node:assert/strict';
import {directionSector,evaluateShadow,shadowReport,splitTemporal} from '../analizar-calibracion-sombra.mjs';

const pair=({time,forecast=20,observed=24,direction=10,station='A',lead=6})=>({
  station:{id:station,label:station,sector:'prueba'},
  provider:'open_meteo',
  model_selection:'best_match',
  nominal_lead_hours:lead,
  valid_time_utc:time,
  forecast:{wind_speed_10m_kmh:10,wind_gust_10m_kmh:forecast,wind_direction_deg:direction},
  observation:{wind_speed_10m_kmh:10,wind_gust_10m_kmh:observed,wind_direction_deg:220}
});

test('v91.385 normaliza los ocho sectores y rechaza direcciones ausentes',()=>{
  assert.deepEqual([0,44,90,136,180,226,270,316,359].map(directionSector),
    ['N','NE','E','SE','S','SO','O','NO','N']);
  assert.equal(directionSector(null),null);
  assert.equal(directionSector('x'),null);
});

test('v91.385 separa entrenamiento y comprobación por bloques UTC',()=>{
  const pairs=[
    pair({time:'2026-08-31T23:00:00.000Z'}),
    pair({time:'2026-09-01T00:00:00.000Z'})
  ];
  const split=splitTemporal(pairs,'2026-09-01');
  assert.equal(split.training.length,1);
  assert.equal(split.holdout.length,1);
  assert.throws(()=>splitTemporal(pairs,'01-09-2026'),/YYYY-MM-DD/);
  assert.throws(()=>splitTemporal(pairs,'2026-02-31'),/YYYY-MM-DD/);
});

test('v91.385 aprende solo del bloque anterior y compara antes/después',()=>{
  const training=[
    pair({time:'2026-08-01T00:00:00.000Z'}),
    pair({time:'2026-08-02T00:00:00.000Z'})
  ];
  const holdout=[pair({time:'2026-09-01T00:00:00.000Z',forecast:30,observed:34})];
  const result=evaluateShadow(training,holdout);
  assert.equal(result.additive_correction_kmh,4);
  assert.equal(result.holdout_before.gust.bias_kmh,-4);
  assert.equal(result.holdout_after.gust.bias_kmh,0);
  assert.equal(result.comparable,true);
});

test('v91.385 estratifica con la dirección prevista y conserva estación/horizonte',()=>{
  const pairs=[
    pair({time:'2026-08-01T00:00:00.000Z',direction:5}),
    pair({time:'2026-09-01T00:00:00.000Z',direction:5})
  ];
  const report=shadowReport(pairs,{holdoutFrom:'2026-09-01'});
  const directional=report.find(row=>row.scope==='station_horizon_direction');
  assert.equal(directional.forecast_direction_sector,'N');
  assert.equal(directional.station.id,'A');
  assert.equal(directional.nominal_lead_hours,6);
  assert.equal(directional.comparable,true);
});
