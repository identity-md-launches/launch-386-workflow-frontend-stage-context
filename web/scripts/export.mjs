import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak256, toHex, parseAbi } from 'viem';

const root = new URL('../../', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const handoff = await read('web/config/handoff.json');
const { network, walletAddChain } = await read('web/config/network.json');
const workflow = await read('web/config/workflow.json');
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
if (network.chainId !== handoff.chainId || parseInt(walletAddChain.chainId) !== handoff.chainId) throw Error('Chain mismatch');
await mkdir(new URL('dist/abi/', root), { recursive: true });
const contracts = [];
for (const { name, address, abiHash } of handoff.contracts) {
  const bytes = execFileSync('git', ['show', `${handoff.sourceCommit}:docs/abi/${name}.json`], { cwd: root });
  const abi = JSON.parse(bytes);
  if (!Array.isArray(abi)) throw Error(`${name}: expected raw ABI array`);
  const actual = keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
  if (actual !== abiHash) throw Error(`${name}: ABI hash mismatch ${actual}`);
  const abiPath = `abi/${name}.json`;
  await writeFile(new URL(`dist/${abiPath}`, root), bytes);
  contracts.push({ name, address, abiHash, abiPath });
  console.log(`Verified ${name}: ${actual}`);
}
// Public protocol interfaces; deployment ABIs above always come from the pinned implementation.
const key = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';
const interfaces = {
  PoolSwapTest: parseAbi([key,
    'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }',
    'struct TestSettings { bool takeClaims; bool settleUsingBurn; }',
    'function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256 delta)',
    'function manager() view returns (address)',
    'error NoSwapOccurred()',
    'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  ]),
  V4Quoter: parseAbi([key,
    'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
    'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  ]),
  StateView: parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']),
};
const protocolAbis = {};
for (const [name, abi] of Object.entries(interfaces)) {
  protocolAbis[name] = `abi/${name}.json`;
  await writeFile(new URL(`dist/${protocolAbis[name]}`, root), JSON.stringify(abi, null, 2) + '\n');
}
const files = async (dir, prefix = '') => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async item => {
  const path = prefix + item.name;
  return item.isDirectory() ? files(new URL(item.name + '/', dir), path + '/') : [path];
}))).flat();
const assets = [];
for (const path of (await files(new URL('dist/', root))).sort()) {
  if (path === 'imd-deployment.json') continue;
  const bytes = await readFile(new URL(`dist/${path}`, root));
  if (bytes.length > 8388608) throw Error('Asset exceeds 8 MiB');
  assets.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (assets.length > 128) throw Error('Too many exported assets');
const { launchId, chainId, sourceCommit, attestationHash } = handoff;
await writeFile(new URL('dist/imd-deployment.json', root), JSON.stringify({
  version: 1, launchId, chainId, sourceCommit, attestationHash, contracts, assets,
  network, walletAddChain, pool: handoff.manifest.pool,
  token: handoff.manifest.token, hook: handoff.manifest.hook.contract,
  deploymentBlock: Math.min(...handoff.contracts.map(c => c.blockNumber)),
  routing: { poolSwapTest: workflow.poolSwapTest, protocolAbis },
}, null, 2) + '\n');
console.log(`Exported deployment manifest with ${assets.length} assets.`);
