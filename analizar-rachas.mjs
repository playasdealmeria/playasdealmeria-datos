#!/usr/bin/env node
/* analizar-rachas.mjs  (repo playasdealmeria-datos)
 *
 * Lee los `rachas_validacion_YYYY-MM.jsonl` que produce `validar-rachas.mjs` y responde:
 * ¿Open-Meteo exagera las rachas frente a la estación real (6325O)? Métricas:
 *   · N pares válidos (con OM y observación).
 *   · SESGO de racha = media(OM_racha − REAL_racha). >0 = Open-Meteo sobre-predice.
 *   · RMSE de racha (km/h).
 *   · «Cried wolf»: OM anuncia racha≥40 y la real fue <25.
 *   · Ratio racha/sostenido OBSERVADO (real): ¿un 4-5× es físico o no?
 * Veredicto heurístico para publicar rachas: sesgo pequeño (|·|≤ ~8 km/h) y pocos «cried
 * wolf» → el modelo es fiable; sesgo alto y falsos vendavales → NO publicar aún.
 *
 * Uso:  node analizar-rachas.mjs [ruta.jsonl ...]   (por defecto: todos los del repo)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const DIR = dirname(fileURLToPath(import.meta.url));

function loadFiles(args){
  let files = args.length ? args : readdirSync(DIR).filter(f=>/^rachas_validacion_\d{4}-\d{2}\.jsonl$/.test(f)).map(f=>join(DIR,f));
  const rows=[];
  for(const f of files){ if(!existsSync(f)){ console.warn('  (no existe: '+f+')'); continue; }
    for(const line of readFileSync(f,'utf8').split('\n')){ const t=line.trim(); if(!t) continue;
      try{ rows.push(JSON.parse(t)); }catch(e){ /* línea corrupta: se ignora */ } } }
  return rows;
}
// Métricas puras (unit-testable)
export function analyze(rows){
  const paired = rows.filter(r=>r && Number.isFinite(r.om_gust) && Number.isFinite(r.obs_gust));
  const n = paired.length;
  if(!n) return { n:0 };
  const errs = paired.map(r=>r.om_gust - r.obs_gust);
  const bias = errs.reduce((a,b)=>a+b,0)/n;
  const rmse = Math.sqrt(errs.reduce((a,b)=>a+b*b,0)/n);
  const mae  = errs.reduce((a,b)=>a+Math.abs(b),0)/n;
  const criedWolf = paired.filter(r=>r.om_gust>=40 && r.obs_gust<25).length;
  const missed    = paired.filter(r=>r.obs_gust>=40 && r.om_gust<25).length; // lo contrario: racha real que no vimos
  const obsRatios = paired.filter(r=>Number.isFinite(r.obs_ratio) && r.obs_ratio>0).map(r=>r.obs_ratio).sort((a,b)=>a-b);
  const pct = q => obsRatios.length? obsRatios[Math.min(obsRatios.length-1, Math.floor(q*obsRatios.length))] : null;
  const verdict = (Math.abs(bias)<=8 && criedWolf/n<=0.05)
    ? 'FIABLE: sesgo y falsos vendavales bajos → publicable con cautela.'
    : 'NO PUBLICAR AÚN: '+(Math.abs(bias)>8?`sesgo ${bias.toFixed(1)} km/h`:'')+(criedWolf/n>0.05?` · ${criedWolf}/${n} falsos vendavales`:'');
  return { n, bias, rmse, mae, criedWolf, missed,
    obsRatio_p50: pct(0.5), obsRatio_p90: pct(0.9), obsRatio_max: obsRatios[obsRatios.length-1]||null, verdict };
}

// Solo corre el informe si se ejecuta directamente (no al importar `analyze` para tests).
if(process.argv[1] && process.argv[1].endsWith('analizar-rachas.mjs')){
  const rows = loadFiles(process.argv.slice(2));
  const a = analyze(rows);
  if(!a.n){ console.log('Sin pares válidos todavía. Deja correr validar-rachas.mjs unos días.'); process.exit(0); }
  console.log('── Validación del modelo de rachas (Open-Meteo vs AEMET 6325O) ──');
  console.log(`  Pares válidos: ${a.n}`);
  console.log(`  Sesgo racha (OM−real): ${a.bias.toFixed(1)} km/h  ${a.bias>0?'(Open-Meteo sobre-predice)':'(infra-predice)'}`);
  console.log(`  RMSE: ${a.rmse.toFixed(1)} km/h · MAE: ${a.mae.toFixed(1)} km/h`);
  console.log(`  «Cried wolf» (OM≥40 y real<25): ${a.criedWolf} (${(100*a.criedWolf/a.n).toFixed(1)}%)`);
  console.log(`  Rachas reales que OM se perdió (real≥40, OM<25): ${a.missed}`);
  console.log(`  Ratio racha/sostenido REAL — mediana ${a.obsRatio_p50} · p90 ${a.obsRatio_p90} · máx ${a.obsRatio_max}`);
  console.log(`  → ${a.verdict}`);
}
