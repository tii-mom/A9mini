// Compatibility entry point. Keep one authoritative measurement implementation.
import {main} from './perf-baseline-v2.mjs';
main().catch(error=>{console.error(error.message);process.exitCode=1});
