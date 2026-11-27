import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function compare(before,after){
 if(before.base!==after.base||JSON.stringify(before.conditions)!==JSON.stringify(after.conditions))throw Error('Measurement conditions differ');
 if(!before.revision||!after.revision)throw Error('Source fingerprints missing');
 if(JSON.stringify(before.scenarios.map(s=>s.id))!==JSON.stringify(after.scenarios.map(s=>s.id)))throw Error('Scenarios differ');
 return before.scenarios.map((s,i)=>{const a=after.scenarios[i];if(s.summary.error||a.summary.error||s.summary.runs!==5||a.summary.runs!==5)throw Error('Five valid samples required');
 const b=s.summary.ready.median,n=a.summary.ready.median;if(!Number.isFinite(b)||!Number.isFinite(n)||b<=0)throw Error('Missing ready metric');return {id:s.id,before:b,after:n,improvementPercent:100*(b-n)/b};});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{if(process.argv.length!==4)throw Error('Provide exactly two report files');console.log(JSON.stringify(compare(...process.argv.slice(2).map(p=>JSON.parse(readFileSync(p)))),null,2));}catch(e){console.error(e.message);process.exitCode=1}}
