import { defineChain, encodeAbiParameters, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';

export type Deployment = {
  version: number; launchId: string; chainId: number; sourceCommit: string; attestationHash: string;
  contracts: { name: string; address: Address; abiHash: string; abiPath: string }[];
  assets: { path: string; sha256: string }[];
  network: {
    chainId: number; name: string; testnet: boolean; rpcUrls: string[]; explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number }; faucets: string[];
    uniswapV4: Record<'poolManager' | 'universalRouter' | 'quoter' | 'stateView' | 'positionManager' | 'permit2', Address>;
  };
  walletAddChain: { chainId: Hex; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] };
  pool: { fee: number; tickSpacing: number; pairedCurrency: Address; initialPrice: string };
  token: { contract: string; name: string; symbol: string; decimals: number };
  hook: string; deploymentBlock: number;
  routing: { poolSwapTest: Address; protocolAbis: Record<'PoolSwapTest' | 'V4Quoter' | 'StateView', string> };
};
export const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
export const abiHash = (abi: Abi) => keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
const relative = (path: string) => /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..');
export async function loadConfig() {
  const response = await fetch('./imd-deployment.json', { cache: 'no-cache' });
  if (!response.ok) throw Error('Deployment configuration could not load. Reload the page to try again.');
  const manifest: Deployment = await response.json();
  if (manifest.version !== 1 || manifest.network.chainId !== manifest.chainId || Number(manifest.walletAddChain.chainId) !== manifest.chainId) throw Error('Deployment network mismatch. Transactions are disabled.');
  if (!manifest.network.testnet || manifest.pool.pairedCurrency !== '0x0000000000000000000000000000000000000000') throw Error('This interface requires the attested native-ETH test pool.');
  const abis: Record<string, Abi> = {};
  async function readAbi(name: string, path: string, hash?: string) {
    if (!relative(path)) throw Error('Unsafe ABI path in deployment.');
    const res = await fetch(`./${path}`);
    if (!res.ok) throw Error(`Unable to load ${name} ABI. Reload to retry.`);
    const bytes = await res.arrayBuffer();
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (manifest.assets.find(a => a.path === path)?.sha256 !== sha) throw Error(`${name} asset integrity check failed.`);
    const abi: Abi = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(abi) || (hash && abiHash(abi) !== hash)) throw Error(`${name} implementation ABI hash mismatch.`);
    abis[name] = abi;
  }
  await Promise.all([
    ...manifest.contracts.map(c => readAbi(c.name, c.abiPath, c.abiHash)),
    ...Object.entries(manifest.routing.protocolAbis).map(([name, path]) => readAbi(name, path)),
  ]);
  const token = manifest.contracts.find(c => c.name === manifest.token.contract);
  const hook = manifest.contracts.find(c => c.name === manifest.hook);
  if (!token || !hook || manifest.contracts.length !== 2) throw Error('Incomplete deployment contract set.');
  const poolKey = { currency0: manifest.pool.pairedCurrency as Address, currency1: token.address, fee: manifest.pool.fee, tickSpacing: manifest.pool.tickSpacing, hooks: hook.address };
  const poolId = keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
  ], [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
  const chain = defineChain({ id: manifest.chainId, name: manifest.network.name,
    nativeCurrency: manifest.network.nativeCurrency, rpcUrls: { default: { http: manifest.network.rpcUrls } },
    blockExplorers: { default: { name: 'Explorer', url: manifest.network.explorer } }, testnet: manifest.network.testnet });
  return { manifest, abis, token, hook, poolKey, poolId, chain };
}
export type Config = Awaited<ReturnType<typeof loadConfig>>;
