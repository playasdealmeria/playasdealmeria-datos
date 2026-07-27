import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics,
  dedupeRecords,
  groupedReport,
  joinExact,
  parseJsonl,
  validateRecord
} from '../analizar-rachas.mjs';
import {
  forecastRecords,
  mergeArchive,
  normalizeUtc,
  observationRecords,
  parseArchive,
  parseLeadHours
} from '../validar-rachas.mjs';

const station={id:'TEST',label:'Estación de prueba',sector:'prueba',lat:36.8,lng:-2.4};

function observation(valid,wind=10,gust=20,captured='2026-07-01T13:05:00.000Z'){
  return {
    schema_version:2,
    kind:'observation',
    record_id:`observation:aemet:TEST:${valid}`,
    provider:'aemet_opendata',
    station,
    captured_at:captured,
    valid_time_utc:valid,
    variables:{wind_speed_10m_kmh:wind,wind_gust_10m_kmh:gust,wind_direction_deg:180}
  };
}

function forecast(valid,lead=1,wind=12,gust=24,captured='2026-07-01T11:17:00.000Z',suffix='a'){
  return {
    schema_version:2,
    kind:'forecast',
    record_id:`forecast:${suffix}`,
    provider:'open_meteo',
    model_selection:'best_match',
    station,
    captured_at:captured,
    valid_time_utc:valid,
    nominal_lead_hours:lead,
    variables:{wind_speed_10m_kmh:wind,wind_gust_10m_kmh:gust,wind_direction_deg:190}
  };
}

test('normaliza horas AEMET y valida la lista de horizontes',()=>{
  assert.equal(normalizeUtc('2026-07-01T12:00:00+0000'),'2026-07-01T12:00:00.000Z');
  assert.deepEqual(parseLeadHours('24,1,6,6,-1,x'),[1,6,24]);
});

test('convierte observaciones AEMET sin redondear prematuramente a enteros',()=>{
  const rows=observationRecords(station,[{
    idema:'TEST',
    fint:'2026-07-01T12:00:00+0000',
    vv:3.45,
    vmax:7.25,
    dv:220
  }],'2026-07-01T12:20:00.000Z');
  assert.equal(rows.length,1);
  assert.equal(rows[0].variables.wind_speed_10m_kmh,12.4);
  assert.equal(rows[0].variables.wind_gust_10m_kmh,26.1);
});

test('no convierte ausencias de AEMET en falsos ceros y conserva el cero real',()=>{
  const captured='2026-07-01T12:20:00.000Z';
  const missing=observationRecords(station,[{
    idema:'TEST',
    fint:'2026-07-01T12:00:00+0000',
    vv:null,
    vmax:''
  }],captured);
  assert.equal(missing.length,0);

  const calm=observationRecords(station,[{
    idema:'TEST',
    fint:'2026-07-01T12:00:00+0000',
    vv:0,
    vmax:0
  }],captured);
  assert.equal(calm.length,1);
  assert.equal(calm[0].variables.wind_speed_10m_kmh,0);
  assert.equal(calm[0].variables.wind_gust_10m_kmh,0);
});

test('extrae snapshots de Open-Meteo con hora UTC y horizonte explícitos',()=>{
  const payload={
    latitude:36.81,
    longitude:-2.39,
    elevation:20,
    timezone:'GMT',
    hourly:{
      time:['2026-07-01T13:00','2026-07-01T14:00'],
      wind_speed_10m:[10,11],
      wind_gusts_10m:[20,21],
      wind_direction_10m:[180,190]
    }
  };
  const rows=forecastRecords([station],payload,'2026-07-01T12:17:00.000Z',[1]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].valid_time_utc,'2026-07-01T13:00:00.000Z');
  assert.equal(rows[0].nominal_lead_hours,1);
  assert.equal(rows[0].model_run_utc,null);
});

test('un JSONL corrupto aborta y no se ignora en silencio',()=>{
  assert.throws(()=>parseJsonl('{"schema_version":2}\nno-json\n','x.jsonl'),/kind inválido|JSON inválido/);
  assert.throws(()=>parseArchive('{"schema_version":2,"kind":"forecast","record_id":"x"}\n{'),/JSON inválido/);
});

test('el archivo y el análisis eliminan duplicados por record_id',()=>{
  const valid='2026-07-01T12:00:00.000Z';
  const a=forecast(valid), b={...a};
  assert.equal(dedupeRecords([a,b]).length,1);
  assert.equal(mergeArchive([a],[b]).length,1);
});

test('solo empareja estación y hora UTC exactas',()=>{
  const valid='2026-07-01T12:00:00.000Z';
  const wrong='2026-07-01T13:00:00.000Z';
  assert.equal(joinExact([forecast(valid),observation(wrong)]).length,0);
  assert.equal(joinExact([forecast(valid),observation(valid)]).length,1);
});

test('rechaza look-ahead y conserva el último snapshot anterior a la hora válida',()=>{
  const valid='2026-07-01T12:00:00.000Z';
  const early=forecast(valid,1,10,20,'2026-07-01T11:17:00.000Z','early');
  const late=forecast(valid,1,11,21,'2026-07-01T11:47:00.000Z','late');
  const after=forecast(valid,1,99,99,'2026-07-01T12:01:00.000Z','after');
  const pairs=joinExact([early,late,after,observation(valid)]);
  assert.equal(pairs.length,1);
  assert.equal(pairs[0].forecast.wind_gust_10m_kmh,21);
});

test('calcula métricas y eventos sin emitir un veredicto de fiabilidad',()=>{
  const pairs=[
    joinExact([
      forecast('2026-07-01T12:00:00.000Z',1,12,50),
      observation('2026-07-01T12:00:00.000Z',10,45)
    ])[0],
    joinExact([
      forecast('2026-07-02T12:00:00.000Z',1,8,20,'2026-07-02T11:17:00.000Z','b'),
      observation('2026-07-02T12:00:00.000Z',10,40,'2026-07-02T13:05:00.000Z')
    ])[0]
  ];
  const metrics=computeMetrics(pairs);
  assert.equal(metrics.n,2);
  assert.equal(metrics.days,2);
  assert.equal(metrics.gust.bias_kmh,-7.5);
  assert.equal(metrics.events.hits,1);
  assert.equal(metrics.events.misses,1);
  assert.equal('verdict' in metrics,false);
  assert.equal(groupedReport(pairs).some(x=>x.scope==='station'),true);
});

test('validateRecord exige campos científicos mínimos',()=>{
  assert.throws(()=>validateRecord({schema_version:2,kind:'forecast'}),/record_id/);
  const valid='2026-07-01T12:00:00.000Z';
  const invalid=observation(valid);
  invalid.variables={wind_speed_10m_kmh:null,wind_gust_10m_kmh:''};
  assert.throws(()=>validateRecord(invalid),/faltan viento o racha/);
});
