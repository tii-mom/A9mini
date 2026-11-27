import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./candidate-chain-check.mjs', import.meta.url));
function rejected(args, expected, input) {
  const run = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, expected);
  assert.equal(run.stdout, '');
}

test('candidate CLI rejects invalid round IDs and extra execution flags', () => {
  for (const id of ['0', '-1', '1.5', '4294967296']) rejected(['round', id], /positive uint32/);
  rejected(['round', '6', '--execute'], /Usage/);
});

test('candidate CLI rejects a mainnet package before RPC', () => {
  rejected(['w5', '/dev/stdin'], /Expected a Testnet package/, JSON.stringify({network:'mainnet',chainId:'-239'}));
});
