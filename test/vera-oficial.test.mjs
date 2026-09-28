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
test('v91.391 Vera se divide con identidad propia y kill-switch',()=>{assert.ok(src.includes('veraGroups391(flags'));assert.ok(src.includes('VERA_OFICIAL=false'));});
