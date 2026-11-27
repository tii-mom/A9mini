// Read-only HTTP collection; local archive writes only. No signing/deployment/database access.
import {mkdirSync, openSync, closeSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {MarketSampleArchive, fetchRealProviderSamples, createRecentPoll, sha256Hex} from './market-oracle.mjs';

export async function collectMarketOnce({archivePath, binding, start, settlementLagSeconds = 60, ...fetchOptions}) {
  if (!archivePath) throw new Error('archivePath required');
  if (!Number.isInteger(settlementLagSeconds) || settlementLagSeconds < 0) throw new Error('invalid settlement lag');
  mkdirSync(dirname(archivePath), {recursive:true});
  const lock = `${archivePath}.collect.lock`;
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch(e) {
    if (e.code === 'EEXIST') throw new Error('COLLECTOR_LOCKED: do not run concurrent archive writers');
    throw e;
  }
  try {
    writeFileSync(fd, JSON.stringify({pid:process.pid}));
    const archive = new MarketSampleArchive(archivePath, binding);
    const before = archive.load();
    const result = await fetchRealProviderSamples({binding, ...fetchOptions});
    const captureFile = `${archivePath}.capture-${sha256Hex(result.rawPayload).slice(2,18)}.json`;
    writeFileSync(captureFile, JSON.stringify(result,null,2), {mode:0o600});
    const end = result.observedUntil - settlementLagSeconds;
    const previousEnd = Math.max(0, ...before.coverageSegments.map(s => s.end));
    const from = start ?? (previousEnd ? previousEnd - 1 : end - 60);
    if (!Number.isInteger(from) || from <= 0 || end <= from || end - from > 3600) {
      throw new Error('COLLECTION_INTERVAL_UNPROVEN: interval must be positive and <= 1 hour; backfill required');
    }
    let poll;
    try { poll = createRecentPoll(result, {start:from, end}); } catch(e) {
      // Retain the real failure evidence without extending accepted coverage.
      writeFileSync(`${archivePath}.rejected-${sha256Hex(result.rawPayload).slice(2,18)}.json`, JSON.stringify({reason:e.message,result},null,2), {mode:0o600});
      throw e;
    }
    const after = archive.appendPoll(poll);
    return {ok:true,broadcasted:false,start:from,end,rawSha256:sha256Hex(result.rawPayload),
      samples:after.samples.length,segments:after.coverageSegments.length,
      captureFile, scope:'provider-observed recent feed; not chain-finality or A9 mainnet acceptance'};
  } finally {closeSync(fd);unlinkSync(lock);}
}
