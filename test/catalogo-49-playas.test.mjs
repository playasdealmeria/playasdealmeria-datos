import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const catalog=JSON.parse(readFileSync(fileURLToPath(new URL('../playas_catalogo.json',import.meta.url)),'utf8'));
const source=readFileSync(fileURLToPath(new URL('../build-data.mjs',import.meta.url)),'utf8');
test('v91.377 datos: catalogo 49, ids estables y coordenadas propias',()=>{
  assert.equal(catalog.length,49);assert.equal(new Set(catalog.map(b=>b.id)).size,49);
  const byId=Object.fromEntries(catalog.map(b=>[String(b.id),b]));
  assert.equal(byId['3'].nombre,'Los Baños / Guardias Viejas');assert.equal(byId['3'].lat,36.695583988467185);
  assert.equal(byId['50'].nombre,'Playa de Balerma');assert.equal(byId['51'].nombre,'Cala Higuera');assert.equal(byId['52'].nombre,'Playa del Embarcadero');
  for(const id of ['3','50','51','52'])assert.equal(byId[id].kw.length,24,'curva direccional de '+id);
  assert.ok(!(byId['23'].alias||[]).includes('El Embarcadero'),'el alias pasa a la playa nueva');
});
test('v91.377 datos: Junta y El Ejido ya no mezclan Balerma con Guardias',()=>{
  assert.match(source,/'3':16460/);assert.match(source,/'50':16222/);assert.match(source,/'51':16255/);assert.match(source,/'52':16331/);
  assert.ok(source.includes("const EJIDO_MAP = { '3':[6,8], '4':[2,3], '50':[4] }"));
  assert.ok(!source.includes("'3':[4,6,8]"));
});
