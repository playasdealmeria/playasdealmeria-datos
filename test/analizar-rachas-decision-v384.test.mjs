import test from 'node:test';
import assert from 'node:assert/strict';
import {computeMetrics,strongEpisodes} from '../analizar-rachas.mjs';

const pair=(station,time,lead,observed,forecast)=>({
  station:{id:station,label:station,sector:'prueba'},
  provider:'open_meteo',
  model_selection:'best_match',
  nominal_lead_hours:lead,
  captured_at:new Date(Date.parse(time)-lead*3600000).toISOString(),
  valid_time_utc:time,
  forecast:{wind_speed_10m_kmh:10,wind_gust_10m_kmh:forecast},
  observation:{wind_speed_10m_kmh:10,wind_gust_10m_kmh:observed}
});

test('v91.384 cuenta episodios por estación sin duplicar horizontes',()=>{
  const rows=[
    pair('A','2026-09-01T00:00:00.000Z',1,42,38),
    pair('A','2026-09-01T00:00:00.000Z',6,42,38),
    pair('A','2026-09-01T02:00:00.000Z',1,45,41),
    pair('A','2026-09-01T06:00:00.000Z',1,44,43),
    pair('B','2026-09-01T00:00:00.000Z',1,39,41)
  ];
  const episodes=strongEpisodes(rows);
  assert.equal(episodes.length,2);
  assert.equal(episodes[0].slots,2);
  assert.equal(episodes[0].max_gust_kmh,45);
  assert.equal(episodes[1].slots,1);
});

test('v91.384 informa umbrales y tramos sin emitir una recalibración',()=>{
  const rows=[
    pair('A','2026-09-01T00:00:00.000Z',1,42,38),
    pair('A','2026-09-01T00:00:00.000Z',6,42,38),
    pair('A','2026-09-01T02:00:00.000Z',1,45,41),
    pair('A','2026-09-01T06:00:00.000Z',1,44,43),
    pair('B','2026-09-01T00:00:00.000Z',1,39,41)
  ];
  const metrics=computeMetrics(rows);
  assert.deepEqual(metrics.thresholds.map(x=>x.threshold_kmh),[17,23,40]);
  assert.deepEqual(metrics.thresholds[2],{
    threshold_kmh:40,observed:4,forecast:3,hits:2,misses:2,
    false_alarms:1,true_negatives:0,recall:0.5,precision:0.667
  });
  assert.equal(metrics.gust_bands.exact,2);
  assert.equal(metrics.gust_bands.exact_rate,0.4);
  assert.equal(metrics.strong_observation_episodes.count,2);
  assert.equal('correction' in metrics,false);
  assert.equal('verdict' in metrics,false);
});

test('v91.384 rechaza parámetros de episodio inválidos',()=>{
  assert.throws(()=>strongEpisodes([],{threshold:'x'}),/parámetros/);
  assert.throws(()=>strongEpisodes([],{maxGapHours:-1}),/parámetros/);
});
