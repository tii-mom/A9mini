// Compatibility entry point for the validated comparison tool.
import {readFileSync} from 'node:fs';
import {compare} from './perf-compare-v2.mjs';
try {
 if(process.argv.length!==4)throw Error('Provide exactly two report files');
 console.log(JSON.stringify(compare(...process.argv.slice(2).map(file=>JSON.parse(readFileSync(file,'utf8')))),null,2));
}catch(error){console.error(error.message);process.exitCode=1}
