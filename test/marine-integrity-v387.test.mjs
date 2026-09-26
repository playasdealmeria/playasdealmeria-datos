import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../build-data.mjs',import.meta.url),'utf8');
function grab(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);let i=source.indexOf('{',start),depth=0;for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}return source.slice(start,i+1);}
const ctx={MARINE_BEST_SUFFIX:'marine_best_match',MARINE_COMPARE_SUFFIXES:['meteofrance_wave','dwd_ewam','ecmwf_wam']};vm.createContext(ctx);
for(const name of ['validNum','avg','meanDir','marineSeries','marineMembers','aggregateWaveModels','normalizeMarineResponse'])vm.runInContext(grab(name),ctx);
const plain=x=>JSON.parse(JSON.stringify(x));
test('ausencias de modelos no se convierten en altura, rumbo o periodo cero',()=>{
  for(const value of [null,undefined,'',' ',false,true,'0',NaN,Infinity,-1]){
    const h={wave_height_meteofrance_wave:[value]};assert.deepEqual(plain(ctx.marineMembers(h,0,'wave_height','wave_direction','wave_period')),[]);
  }
  const h={wave_height_meteofrance_wave:[0],wave_direction_meteofrance_wave:[null],wave_period_meteofrance_wave:[null]};
  assert.deepEqual(plain(ctx.marineMembers(h,0,'wave_height','wave_direction','wave_period')),[{m:'meteofrance_wave',h:0}]);
  h.wave_direction_meteofrance_wave=[0];h.wave_period_meteofrance_wave=[5];
  assert.deepEqual(plain(ctx.marineMembers(h,0,'wave_height','wave_direction','wave_period')),[{m:'meteofrance_wave',h:0,d:0,p:5}]);
});
test('el agregado no añade miembros ausentes ni contamina rumbo o periodo válidos',()=>{
  const rows=[{waveModels:[{m:'meteofrance_wave',h:null,d:0,p:0},{m:'dwd_ewam',h:0,d:null,p:null}]},{waveModels:[{m:'dwd_ewam',h:1,d:90,p:6}]}];
  assert.deepEqual(plain(ctx.aggregateWaveModels(rows)),[{m:'dwd_ewam',h:.5,d:90,p:6}]);
  assert.deepEqual(plain(ctx.aggregateWaveModels([{waveModels:[{m:'dwd_ewam',h:0,d:null,p:null}]}])),[{m:'dwd_ewam',h:0}]);
});
test('Best Match conserva el valor central cuando falta un miembro de comparación',()=>{
  const n=ctx.normalizeMarineResponse({hourly:{time:['2026-09-26T10:00'],wave_height_marine_best_match:[.8],wave_height_meteofrance_wave:[null],wave_height_dwd_ewam:[1]},daily:{time:[]}});
  assert.equal(n.hourly.wave_height[0],.8);assert.equal(n.hourly.wave_models[0].length,1);
});
test('la probabilidad ausente llega como null y el cero observado sigue siendo cero',()=>{
  const line=source.split(/\r?\n/).find(x=>x.includes('hourly.pop.push('));
  const apply=new Function('hr','i','const hourly={pop:[]};'+line+';return hourly.pop[0];');
  for(const value of [null,undefined,'',false,NaN,Infinity,-1,101])assert.equal(apply({precipitation_probability:[value]},0),null);
  assert.equal(apply({precipitation_probability:[0]},0),0);assert.equal(apply({precipitation_probability:[65]},0),65);
});
test('el escenario diario conserva el rumbo disponible sin fabricar norte',()=>{
  const line=source.split(/\r?\n/).find(x=>x.includes('      windDir:'));
  const apply=new Function('dir','return ({'+line+'});');
  assert.equal(apply(90).windDir,90);assert.equal(apply(0).windDir,0);assert.equal(apply(null).windDir,null);
  assert.match(source,/const dir=d\.wind_direction_10m_dominant[^\n]+:null\)\?\?null/);
});
