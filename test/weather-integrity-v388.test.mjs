import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const source=fs.readFileSync(new URL('../build-data.mjs',import.meta.url),'utf8');
test('ingesta horaria publica null para ausencias de temperatura viento y cielo',()=>{
 for(const [field,raw] of [['temp','temperature_2m'],['wind','wind_speed_10m'],['gust','wind_gusts_10m'],['wdir','wind_direction_10m'],['code','weather_code']]){
 const line=source.split(/\r?\n/).find(x=>x.includes('hourly.'+field+'.push('));const run=new Function('hr','i','const hourly={'+field+':[]};'+line+';return hourly.'+field+'[0];');
 for(const v of [null,undefined,'',' ',false,true,NaN,Infinity])assert.equal(run({[raw]:[v]},0),null,field);
 assert.equal(run({[raw]:[0]},0),0,field);assert.equal(run({},0),null,field);}
});
test('código ausente no fabrica descripción de cielo',()=>{
 const line=source.split(/\r?\n/).find(x=>x.startsWith('function codeEstado('));const fn=new Function(line+';return codeEstado;')();
 for(const v of [null,undefined,'',false,NaN])assert.equal(fn(v).estado,'desconocido');assert.equal(fn(0).estado,'sol');
 assert.ok(!source.includes('codeEstado(code==null?0:code)'));
});
test('resumen diario sin viento conserva fuerza y rachas ausentes',()=>{
 for(const field of ['fuerza','rachas']){const line=source.split(/\r?\n/).find(x=>x.startsWith('      '+field+':'));const run=new Function('spd','const d={},cur={},i=1;return ({'+line+'}).'+field+';');assert.equal(run(null),null);assert.equal(run(0),0);}
});
