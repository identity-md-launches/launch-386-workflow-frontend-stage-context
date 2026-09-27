import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http, encodeAbiParameters, keccak256, type Abi, type Address } from 'viem';
const root = new URL('../../', import.meta.url);
const config = JSON.parse(await readFile(new URL('dist/imd-deployment.json', root), 'utf8'));
const abis: Record<string, Abi> = {};
for (const c of config.contracts) abis[c.name] = JSON.parse(await readFile(new URL(`dist/${c.abiPath}`, root), 'utf8'));
abis.StateView = JSON.parse(await readFile(new URL('dist/abi/StateView.json', root), 'utf8'));
abis.PoolSwapTest = JSON.parse(await readFile(new URL('dist/abi/PoolSwapTest.json', root), 'utf8'));
abis.V4Quoter = JSON.parse(await readFile(new URL('dist/abi/V4Quoter.json', root), 'utf8'));
const token = config.contracts.find((c: { name: string }) => c.name === config.token.contract);
const hook = config.contracts.find((c: { name: string }) => c.name === config.hook);
const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [config.pool.pairedCurrency, token.address, config.pool.fee, config.pool.tickSpacing, hook.address]));
const results = await Promise.all(config.network.rpcUrls.map(async (url: string) => {
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 10000 }) });
  try {
    const chainId = await client.getChainId();
    if (chainId !== config.chainId) throw Error(`Wrong chain ${chainId}`);
    const addresses = [...config.contracts, { name: 'PoolSwapTest', address: config.routing.poolSwapTest }, ...Object.entries(config.network.uniswapV4).map(([name, address]) => ({ name, address }))];
    const code = await Promise.all(addresses.map(async ({ name, address }) => ({ name, address, bytes: ((await client.getCode({ address: address as Address }))?.length ?? 2) / 2 - 1 })));
    const block = await client.getBlockNumber();
    const slots = await client.readContract({ address: hook.address, abi: abis[hook.name], functionName: 'swapsInBlock', args: [poolId], blockNumber: block });
    const slot0 = await client.readContract({ address: config.network.uniswapV4.stateView, abi: abis.StateView, functionName: 'getSlot0', args: [poolId], blockNumber: block });
    const manager = await client.readContract({ address: config.routing.poolSwapTest, abi: abis.PoolSwapTest, functionName: 'manager' });
    let quote: unknown;
    try {
      quote = (await client.simulateContract({ address: config.network.uniswapV4.quoter, abi: abis.V4Quoter, functionName: 'quoteExactInputSingle', args: [{ poolKey: { currency0: config.pool.pairedCurrency, currency1: token.address, fee: config.pool.fee, tickSpacing: config.pool.tickSpacing, hooks: hook.address }, zeroForOne: true, exactAmount: 1000000000000n, hookData: '0x' }] })).result;
    } catch (e) { quote = { error: String(e).slice(0, 600) }; }
    return { url, chainId, block, code, poolId, slots, slot0, routerManager: manager, quoteFor0000001ETH: quote, result: code.every(c => c.bytes > 0) ? 'pass' : 'missing code' };
  } catch (e) { return { url, result: 'unavailable', error: String(e).slice(0, 800) }; }
}));
const report = { checkedAt: new Date().toISOString(), method: 'Read-only JSON-RPC. No transactions sent.', results };
const text = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
await writeFile(new URL('docs/evidence/live-chain.json', root), text);
console.log(text);
