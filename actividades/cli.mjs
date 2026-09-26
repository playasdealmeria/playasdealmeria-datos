import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {collect,plan,restore,inspect} from './collector.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('./catalog.json',import.meta.url)));
try{
  const [command,...args]=process.argv.slice(2);
  if(command==='plan'&&args.length<=1)console.log(JSON.stringify({requests:plan(catalog,{opticalDate:args[0]??null}).length,beaches:49,scheduled:false},null,2));
  else if(command==='capture'&&args.length>=2&&args.length<=3){
    const [root,cycle,opticalDate]=args;const r=await collect({catalog,root,cycle,opticalDate:opticalDate??null});console.log(JSON.stringify(r,null,2));if(r.status==='saved_with_gaps')process.exitCode=2;
  }else if(command==='verify'&&args.length===1)console.log(JSON.stringify(inspect(args[0]),null,2));
  else if(command==='restore'&&args.length===2)console.log('Capturas restauradas:',restore(...args));
  else throw Error('Uso: node '+fileURLToPath(import.meta.url)+' plan [FECHA_OPTICA] | capture CARPETA_PRIVADA CICLO [FECHA_OPTICA] | verify CAPTURA | restore ORIGEN DESTINO');
}catch(e){console.error(e.message);process.exitCode=1;}
