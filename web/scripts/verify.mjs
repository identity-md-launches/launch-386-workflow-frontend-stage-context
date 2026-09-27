import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';

const root = new URL('../../', import.meta.url);
const read = async p => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const handoff = await read('web/config/handoff.json');
const manifest = await read('dist/imd-deployment.json');
const { network, walletAddChain } = await read('web/config/network.json');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
for (const key of ['version', 'launchId', 'chainId', 'sourceCommit', 'attestationHash']) assert.equal(manifest[key], handoff[key], key);
assert.deepEqual(manifest.network, network);
assert.deepEqual(manifest.walletAddChain, walletAddChain);
assert.deepEqual(manifest.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash })), handoff.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash })));
for (const c of manifest.contracts) {
  const bytes = await readFile(new URL(`dist/${c.abiPath}`, root));
  assert.deepEqual(bytes, execFileSync('git', ['show', `${handoff.sourceCommit}:docs/abi/${c.name}.json`], { cwd: root }));
  assert.equal(keccak256(toHex(JSON.stringify(canonical(JSON.parse(bytes))))).slice(2), c.abiHash);
}
const list = async (dir, prefix = '') => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async item => item.isDirectory() ? list(new URL(item.name + '/', dir), prefix + item.name + '/') : [prefix + item.name]))).flat();
const files = (await list(new URL('dist/', root))).filter(p => p !== 'imd-deployment.json').sort();
assert.deepEqual(manifest.assets.map(a => a.path).sort(), files);
assert.ok(files.includes('index.html') && files.length <= 128);
let bytes = 0;
for (const a of manifest.assets) {
  assert.ok(!a.path.startsWith('/') && !a.path.includes('..') && !a.path.includes('://'));
  const data = await readFile(new URL(`dist/${a.path}`, root));
  assert.ok(data.length <= 8388608);
  bytes += data.length;
  assert.equal(createHash('sha256').update(data).digest('hex'), a.sha256, a.path);
}
bytes += (await readFile(new URL('dist/imd-deployment.json', root))).length;
assert.ok(bytes < 32 * 1024 * 1024);
const html = await readFile(new URL('dist/index.html', root), 'utf8');
assert.ok(!/(?:src|href)="\/assets\//.test(html));
console.log(JSON.stringify({ result: 'pass', assets: files.length, exportBytes: bytes, canonicalAbiHashes: 'verified', network: 'unchanged', relativeBase: true }, null, 2));
