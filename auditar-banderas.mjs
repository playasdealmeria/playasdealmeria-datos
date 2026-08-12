#!/usr/bin/env node
/* v91.380: diagnostico no critico. Persistencia no significa falsedad: solo abre revision. */
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function catalogNames(dir){try{return Object.fromEntries(JSON.parse(readFileSync(resolve(dir,'playas_catalogo.json'),'utf8')).map(b=>[String(b.id),String(b.nombre||b.name||('playa '+b.id))]));}catch{return {};}}

export function auditRows(rows,{windowDays=7,minReadings=20,minDays=3}={}){
  const valid=(rows||[]).filter(r=>r&&r.ts&&r.id!=null&&r.oflag&&Number.isFinite(Date.parse(r.ts)));
  if(!valid.length)return [];
  const latest=Math.max(...valid.map(r=>Date.parse(r.ts))),cut=latest-windowDays*86400000,groups=new Map();
  for(const r of valid){if(Date.parse(r.ts)<cut)continue;const id=String(r.id),g=groups.get(id)||{id:Number(r.id),values:new Set(),days:new Set(),sources:new Set(),readings:0};g.values.add(String(r.oflag));g.days.add(String(r.ts).slice(0,10));g.sources.add(String(r.oflagSource||'historial anterior sin fuente'));g.readings++;groups.set(id,g);}
  return [...groups.values()].filter(g=>g.readings>=minReadings&&g.days.size>=minDays&&g.values.size===1).map(g=>({id:g.id,flag:[...g.values][0],readings:g.readings,days:g.days.size,sources:[...g.sources]})).sort((a,b)=>a.id-b.id);
}

export function readHistory(dir=process.cwd()){
  const files=readdirSync(dir).filter(x=>/^banderas_historico_\d{4}-\d{2}\.jsonl$/.test(x)).sort(),rows=[];
  for(const f of files)for(const line of readFileSync(resolve(dir,f),'utf8').split(/\r?\n/)){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{}}
  return rows;
}

export function main(dir=process.cwd()){
  const findings=auditRows(readHistory(dir)),names=catalogNames(dir);
  const serious=findings.filter(x=>x.flag==='roja'||x.flag==='negra'||x.flag==='amarilla');
  console.log('Auditoria de persistencia: '+findings.length+' playas invariantes en la ventana; '+serious.length+' requieren revision prioritaria.');
  if(serious.length)console.log('::warning::Banderas no verdes persistentes para contrastar: '+serious.map(x=>(names[String(x.id)]||('playa '+x.id))+' (#'+x.id+', '+x.flag+', '+x.readings+' lecturas/'+x.days+' dias)').join('; ')+'. Persistencia no prueba vigencia.');
  const green=findings.filter(x=>x.flag==='verde');if(green.length)console.log('::notice::'+green.length+' banderas verdes permanecen invariantes; se conservan y siguen bajo observacion.');
  return findings;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv[2]||process.cwd());
