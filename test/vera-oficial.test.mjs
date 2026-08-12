import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const src=readFileSync(fileURLToPath(new URL('../build-data.mjs',import.meta.url)),'utf8');
const helperLines=src.split(/\r?\n/).filter(line=>line.startsWith('function veraText(')||line.startsWith('function veraFlag('));
assert.equal(helperLines.length,2,'deben existir los dos helpers Vera');
const {veraFlag}=Function(helperLines.join('\n')+';return {veraFlag};')();
test('v91.379 datos: distingue la bandera de bano de la Bandera Azul anual',()=>{
  const html='<h2>EL PLAYAZO</h2><p>Cuenta con BANDERA AZUL.</p><strong>BANDERA AMARILLA</strong><p>AFORO LIBRE</p>';
  assert.equal(veraFlag(html,'EL PLAYAZO'),'amarilla');
});
test('v91.379 datos: valida identidad y rechaza estados ausentes o ambiguos',()=>{
  assert.equal(veraFlag('<h2>PUERTO REY</h2><b>BANDERA VERDE</b>','EL PLAYAZO'),null);
  assert.equal(veraFlag('<h2>PUERTO REY</h2><b>BANDERA VERDE</b><nav>EL PLAYAZO</nav>','EL PLAYAZO'),null);
  assert.equal(veraFlag('<h2>EL PLAYAZO</h2><p>AFORO LIBRE</p>','EL PLAYAZO'),null);
  assert.equal(veraFlag('<h2>EL PLAYAZO</h2><b>BANDERA VERDE</b><b>BANDERA ROJA</b>','EL PLAYAZO'),null);
});
test('v91.379 datos: exige los cuatro sectores, usa la peor bandera y dispone de kill-switch',()=>{
  assert.match(src,/const VERA_BEACHES = \[{id:1,name:'LAS MARINAS-BOLAGA'},\{id:2,name:'EL PLAYAZO'},\{id:3,name:'PUERTO REY'},\{id:4,name:'CALA MARQUES'}\]/);
  assert.match(src,/flags\.length!==VERA_BEACHES\.length/);
  assert.match(src,/flags\.reduce\(\(worst,value\)=>worst\?ejidoWorse\(worst,value\):value,null\)/);
  assert.match(src,/VERA_OFICIAL=false/);
  assert.match(src,/out\['37'\]=\{oflag:flag,oflagSource:VERA_ATTR/);
});
