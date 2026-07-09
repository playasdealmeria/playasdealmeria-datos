#!/usr/bin/env node
/**
 * comprobar-oficiales.mjs — ¿Se mueven los datos oficiales de la Junta?
 *
 * Vive en el REPO DE DATOS. No hace ni una petición: lee el historial de Git.
 * El workflow commitea `datos_playas.json` cada 30 minutos, así que el repo YA es una
 * serie temporal. Este script la lee y responde a dos preguntas:
 *
 *   1. ¿La BANDERA oficial cambia de color a lo largo de los días?
 *      Si nunca cambia, no es un dato en vivo: es un valor congelado.
 *
 *   2. ¿La OCUPACIÓN cambia?
 *      Sospecha fuerte de que NO: la respuesta de la Junta no trae ningún campo de fecha,
 *      `beach_occupation` tiene la misma forma que `sand_type` o `width`, y las 40 playas
 *      la traen — incluidas calas a las que solo se llega en barca.
 *      Por eso la web la tiene apagada (OCUPACION_VISIBLE=false en app.js).
 *
 * Da igual el veredicto: lo importante es dejar de suponer.
 *
 * Uso:
 *   node comprobar-oficiales.mjs              # últimos 200 commits
 *   node comprobar-oficiales.mjs 500          # últimos 500
 *   node comprobar-oficiales.mjs 200 --csv    # además, vuelca serie a oficiales.csv
 *
 * Conviene esperar 48 h desde el primer commit con datos oficiales.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const MAX = Number(process.argv[2]) || 200;
const CSV = process.argv.includes('--csv');
const FICHERO = 'datos_playas.json';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

if (!existsSync(FICHERO)) {
  console.error(`✗ No encuentro ${FICHERO}. Ejecuta esto en la raíz del repo playasdealmeria-datos.`);
  process.exit(1);
}

let commits;
try {
  commits = git('log', `-${MAX}`, '--format=%H\t%cI', '--', FICHERO).trim().split('\n').filter(Boolean);
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('✗ No encuentro el ejecutable `git` en el PATH.');
    console.error('');
    console.error('  No es que esto no sea un repositorio: es que la consola no ve `git`.');
    console.error('  Suele pasar en cmd.exe cuando git llegó con GitHub Desktop.');
    console.error('');
    console.error('  Opciones:');
    console.error('    · Abre "Git Bash" (o el terminal de GitHub Desktop) y lanza esto ahí.');
    console.error('    · O instala Git para Windows: https://git-scm.com/download/win');
    console.error('    · O añade al PATH la carpeta que contiene git.exe.');
  } else {
    console.error('✗ `git log` falló:', e.message.split('\n')[0]);
    console.error('  ¿Estás en la raíz del repositorio playasdealmeria-datos?');
  }
  process.exit(1);
}
if (commits.length < 2) {
  console.error(`✗ Solo ${commits.length} commit(s) de ${FICHERO}. Espera unas horas y vuelve.`);
  process.exit(1);
}
commits.reverse(); // del más antiguo al más reciente

console.log(`Leyendo ${commits.length} versiones de ${FICHERO} del historial de Git…\n`);

const serie = [];   // [{cuando, beaches:{id:{flag,ocu}}}]
let sinOficial = 0;

for (const linea of commits) {
  const [hash, cuando] = linea.split('\t');
  let json;
  try { json = JSON.parse(git('show', `${hash}:${FICHERO}`)); }
  catch { continue; }
  if (!json || !json.beaches) continue;
  if (!json.official) { sinOficial++; continue; }   // anterior a datos v91.9

  const beaches = {};
  for (const [id, b] of Object.entries(json.beaches)) {
    beaches[id] = { flag: b.oflag || null, ocu: b.ocupacionCode || b.ocupacionOficial || null };
  }
  serie.push({ cuando, hash: hash.slice(0, 7), beaches, tls: json.official.tls || '—' });
}

if (serie.length < 2) {
  console.error(`✗ Solo ${serie.length} versión(es) con bloque "official".`);
  console.error(`  (${sinOficial} commits eran anteriores a datos v91.9.)`);
  console.error('  Espera a que el workflow acumule unas horas.');
  process.exit(1);
}

// Si las últimas lecturas vienen vacías, el workflow no está pidiendo los datos.
const ultimas = serie.slice(-6);
const vacias = ultimas.filter(s => Object.values(s.beaches).every(b => !b.flag && !b.ocu)).length;
if (vacias === ultimas.length) {
  console.error('✗ Las últimas ' + ultimas.length + ' lecturas NO traen ningún dato oficial.');
  console.error('');
  console.error('  Comprueba, por este orden:');
  console.error('    1. ¿`JUNTA_OFICIAL: "false"` sigue en el env del workflow? Quítalo.');
  console.error('    2. ¿Está aplicado el parche datos v91.11 (Agent de TLS 1.2)?');
  console.error('    3. En el log del run: "· Datos oficiales Junta: N/40 playas".');
  console.error('');
  console.error('  Sin datos no hay serie que analizar.');
  process.exit(1);
}

const t0 = new Date(serie[0].cuando), t1 = new Date(serie[serie.length - 1].cuando);
const horas = (t1 - t0) / 3600000;
const ids = [...new Set(serie.flatMap(s => Object.keys(s.beaches)))].sort((a, b) => a - b);

console.log(`Ventana: ${t0.toLocaleString('es-ES')} → ${t1.toLocaleString('es-ES')}`);
console.log(`         ${serie.length} lecturas en ${horas.toFixed(1)} h (una cada ${(horas * 60 / (serie.length - 1)).toFixed(0)} min)\n`);

if (horas < 12) {
  console.log('⚠ Menos de 12 h de historial. El veredicto será débil: una bandera puede pasarse');
  console.log('  días en verde sin que eso signifique que está congelada. Vuelve en 48 h.\n');
}

// ── Análisis por playa ──
function analizar(campo) {
  const filas = [];
  for (const id of ids) {
    const vals = serie.map(s => (s.beaches[id] || {})[campo]).filter(v => v !== undefined);
    const presentes = vals.filter(v => v !== null);
    if (!presentes.length) { filas.push({ id, estado: 'nunca', distintos: 0, cambios: 0, valores: [] }); continue; }
    let cambios = 0;
    for (let i = 1; i < presentes.length; i++) if (presentes[i] !== presentes[i - 1]) cambios++;
    const distintos = [...new Set(presentes)];
    const aparece = presentes.length, total = vals.length;
    filas.push({
      id, cambios, distintos: distintos.length, valores: distintos,
      estado: aparece === total ? 'siempre' : `${aparece}/${total}`
    });
  }
  return filas;
}

function informe(titulo, campo) {
  const filas = analizar(campo);
  const conDato = filas.filter(f => f.estado !== 'nunca');
  const conCambios = conDato.filter(f => f.cambios > 0);
  const totalCambios = conDato.reduce((a, f) => a + f.cambios, 0);

  console.log('─'.repeat(72));
  console.log(titulo.toUpperCase());
  console.log('─'.repeat(72));
  console.log(`  Playas con dato:        ${conDato.length} de ${ids.length}`);
  console.log(`  Playas que CAMBIARON:   ${conCambios.length}`);
  console.log(`  Cambios totales:        ${totalCambios}`);

  if (conCambios.length) {
    console.log('\n  Detalle de las que se mueven:');
    for (const f of conCambios.sort((a, b) => b.cambios - a.cambios).slice(0, 15)) {
      console.log(`    playa ${String(f.id).padStart(2)} · ${String(f.cambios).padStart(3)} cambios · valores: ${f.valores.join(', ')}`);
    }
  }

  console.log('\n  VEREDICTO:');
  if (!conDato.length) {
    console.log('    Sin dato en ninguna lectura. Nada que juzgar.');
  } else if (totalCambios === 0 && horas >= 24) {
    console.log(`    ✗ CONGELADO. ${conDato.length} playas, ${serie.length} lecturas, ${horas.toFixed(0)} h, CERO cambios.`);
    console.log('      No es un dato en vivo. Es un atributo de catálogo.');
  } else if (totalCambios === 0) {
    console.log(`    ? Sin cambios todavía, pero solo ${horas.toFixed(1)} h de historial. Insuficiente.`);
  } else {
    console.log(`    ✓ SE MUEVE. ${conCambios.length} playas han cambiado ${totalCambios} veces en ${horas.toFixed(0)} h.`);
    console.log('      Es un dato en vivo.');
  }
  console.log('');
  return { conDato: conDato.length, conCambios: conCambios.length, totalCambios };
}

const rB = informe('1 · Bandera oficial (oflag)', 'flag');
const rO = informe('2 · Ocupación (ocupacionCode)', 'ocu');

// ── Aparición y desaparición: la bandera debería encenderse y apagarse cada día ──
console.log('─'.repeat(72));
console.log('3 · ¿LA BANDERA SE ENCIENDE Y SE APAGA? (izar / arriar)');
console.log('─'.repeat(72));
let apariciones = 0, desapariciones = 0;
for (const id of ids) {
  for (let i = 1; i < serie.length; i++) {
    const a = (serie[i - 1].beaches[id] || {}).flag, b = (serie[i].beaches[id] || {}).flag;
    if (!a && b) apariciones++;
    if (a && !b) desapariciones++;
  }
}
console.log(`  Banderas que aparecieron: ${apariciones}`);
console.log(`  Banderas que desaparecieron: ${desapariciones}`);
console.log('');
if (apariciones + desapariciones === 0 && horas >= 24) {
  console.log('  ✗ El conjunto de playas con bandera NO varía. Si tampoco cambia el color,');
  console.log('    la "bandera oficial" es tan estática como la ocupación.');
} else if (apariciones + desapariciones > 0) {
  console.log('  ✓ El conjunto varía: hay playas que publican bandera unas horas y otras no.');
  console.log('    Coherente con izar por la mañana y arriar al cerrar el servicio.');
} else {
  console.log('  ? Historial corto. Vuelve en 48 h.');
}
console.log('');

// ── Qué hacer con el resultado ──
console.log('─'.repeat(72));
console.log('QUÉ HACER');
console.log('─'.repeat(72));
if (rO.totalCambios === 0 && horas >= 24) {
  console.log('  · Ocupación: confirmado estático. Dejar OCUPACION_VISIBLE=false en app.js.');
  console.log('    Opción: reetiquetarla como "Ocupación habitual (catálogo de la Junta)", sin hora.');
} else if (rO.totalCambios > 0) {
  console.log('  · Ocupación: SE MUEVE. Reactivar con OCUPACION_VISIBLE=true en app.js.');
  console.log('    Mantener "consultado" (no "actualizado"): la hora sigue siendo la de nuestra lectura.');
}
if (rB.totalCambios === 0 && apariciones + desapariciones === 0 && horas >= 24) {
  console.log('  · Bandera: NO se mueve. Revisar si merece llamarse "oficial" o solo "según catálogo".');
} else if (rB.totalCambios > 0 || apariciones + desapariciones > 0) {
  console.log('  · Bandera: se mueve. Todo correcto: la caducidad de 3 h tiene sentido.');
}
console.log(`  · TLS usado en la última lectura: ${serie[serie.length - 1].tls}`);
console.log('');

if (CSV) {
  const lineas = ['fecha,hash,playa,bandera,ocupacion'];
  for (const s of serie) for (const id of ids) {
    const b = s.beaches[id] || {};
    lineas.push(`${s.cuando},${s.hash},${id},${b.flag || ''},${b.ocu || ''}`);
  }
  writeFileSync('oficiales.csv', lineas.join('\n'));
  console.log(`· Serie completa volcada a oficiales.csv (${lineas.length - 1} filas)`);
}
