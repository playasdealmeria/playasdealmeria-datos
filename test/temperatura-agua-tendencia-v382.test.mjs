import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../build-data.mjs',import.meta.url),'utf8');
function grab(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const api=new Function(grab('function marineTimeMs382','function marineDailyAt382')+';return {marineWaterTrend382};')();
test('v91.382 detecta un enfriamiento brusco sin redondearlo a entero',()=>{const mar={current:{time:'2026-09-01T12:00',sea_surface_temperature:21.3},latitude:36.79,longitude:-2.54,hourly:{time:['2026-08-25T12:00','2026-08-29T12:00','2026-09-01T12:00'],sea_surface_temperature:[25.7,24.1,21.3]}};const w=api.marineWaterTrend382(mar);assert.equal(w.change_72h,-2.8);assert.equal(w.change_7d,-4.4);assert.equal(w.rapid,true);assert.equal(w.recent,true);assert.equal(w.status,'current');});
test('v91.382 conserva la fuente y no fabrica cambios cuando faltan datos',()=>{const w=api.marineWaterTrend382({current:{time:'2026-09-01T12:00',sea_surface_temperature:21.5},hourly:{time:[],sea_surface_temperature:[]}});assert.equal(w.source,'Météo-France SST via Open-Meteo Marine');assert.equal(w.change_72h,null);assert.equal(w.change_7d,null);assert.equal(w.resolution_km,8);});
test('v91.382 solicita historia y resuelve oleaje por fecha',()=>{assert.match(source,/past_days=7&forecast_days=/);assert.match(source,/cell_selection=sea/);assert.match(source,/waveH:wh\(dateStr\)/);assert.match(source,/status:'carried'/);assert.match(source,/return \{days:out,hourly,water\}/);});
