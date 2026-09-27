import {
  createPublicClient, createWalletClient, custom, fallback, http, parseUnits, formatUnits,
  decodeErrorResult, type Address, type Hex, type EIP1193Provider, type AbiEvent,
} from 'viem';
import type { Config } from './config';

export type Provider = EIP1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
declare global { interface Window { ethereum?: Provider } }
export type WindowState = { block: bigint; used: number; remaining: number };
export type Snapshot = WindowState & { sqrtPrice: bigint; decimals: number; supply: bigint; symbol: string; at: number };
export type Balance = { eth: bigint; token: bigint; allowance: bigint };
export type HistoryRow = { block: bigint; count: number; transactions: Hex[] };
export type Quote = { amount: bigint; output: bigint; sqrtLimit: bigint; block: bigint; at: number; buy: boolean; hookData: Hex; bps: number; account: Address };
export const shorten = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const units = (amount: bigint, decimals = 18, maximum = 6) => {
  const raw = formatUnits(amount, decimals);
  const [whole, fraction] = raw.split('.');
  return `${BigInt(whole).toLocaleString('en-US')}${fraction ? '.' + fraction.slice(0, maximum).replace(/0+$/, '') : ''}`.replace(/\.$/, '') || '0';
};
export function parseAmount(text: string, decimals: number) {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text.trim()) || (text.split('.')[1]?.length ?? 0) > decimals) throw Error(`Enter a positive amount with at most ${decimals} decimal places.`);
  const value = parseUnits(text.trim(), decimals);
  if (value <= 0n || value >= 2n ** 128n) throw Error('Enter an amount greater than zero and within the quote limit.');
  return value;
}
export function sqrt(value: bigint) {
  if (value < 0n) throw Error('Negative square root');
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
export function priceLimit(current: bigint, buy: boolean, bps: number) {
  if (!Number.isInteger(bps) || bps < 1 || bps > 500) throw Error('Choose a price limit between 0.01% and 5%.');
  const square = current * current * BigInt(buy ? 10000 - bps : 10000 + bps) / 10000n;
  const result = sqrt(square) + (buy ? 1n : 0n);
  if (result <= 4295128739n || result >= 1461446703485210103287273052203988822378723970342n) throw Error('Price is outside the supported swap range.');
  return result;
}
export function decodeDelta(delta: bigint, buy: boolean) {
  const d0 = BigInt.asIntN(128, delta >> 128n), d1 = BigInt.asIntN(128, delta);
  return { input: -(buy ? d0 : d1), output: buy ? d1 : d0 };
}
export function errorMessage(error: unknown, config?: Config): string {
  const seen = new Set<unknown>();
  function walk(e: unknown): string | undefined {
    if (!e || seen.has(e)) return;
    seen.add(e);
    if (typeof e === 'string') {
      if (/RateLimited|rate.?limit.*block/i.test(e)) return 'This block has no slots left. Wait for the next block, refresh, and get a new quote. Refused swaps emit no event.';
      if (config && /^0x[0-9a-f]+$/i.test(e)) {
        try {
          const result = decodeErrorResult({ abi: [...config.abis[config.hook.name], ...config.abis.PoolSwapTest, ...config.abis[config.token.name]], data: e as Hex });
          if (result.errorName === 'RateLimited') return 'This block has no slots left. Wait for the next block, refresh, and get a new quote. Refused swaps emit no event.';
          if (result.errorName === 'WrappedError') return (result.args as unknown[]).map(walk).find(Boolean);
          return `Contract refused the request: ${result.errorName}. Refresh balances and get a new quote.`;
        } catch { /* Not an encoded contract error. */ }
      }
      return;
    }
    if (typeof e === 'object') {
      const obj = e as Record<string, unknown>;
      if (obj.code === 4001) return 'Request declined in your wallet. Nothing was submitted; you can try again.';
      for (const k of ['data', 'cause', 'error', 'message', 'details']) { const found = walk(obj[k]); if (found) return found; }
    }
  }
  return walk(error) ?? (error instanceof Error ? error.message.split('\n')[0] : 'Request failed. Check your connection and try again.');
}
export async function switchChain(provider: Provider, config: Config) {
  const chainId = config.manifest.walletAddChain.chainId;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    const record = error as { code?: number; message?: string; data?: { originalError?: { code?: number } } };
    if (record.code !== 4902 && record.data?.originalError?.code !== 4902 && !/unknown chain|unrecognized chain|not added|not configured/i.test(record.message ?? '')) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [config.manifest.walletAddChain] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
}
export class ChainService {
  client;
  verified = false;
  constructor(public config: Config) {
    this.client = createPublicClient({ chain: config.chain, transport: fallback(config.manifest.network.rpcUrls.map(url => http(url, { timeout: 7000, retryCount: 0 })), { rank: false, retryCount: 0 }), batch: { multicall: false }, cacheTime: 0 });
  }
  async verify() {
    const c = this.config;
    this.verified = false;
    if (await this.client.getChainId() !== c.manifest.chainId) throw Error('RPC returned the wrong chain. Transactions are disabled.');
    const addresses = [...c.manifest.contracts.map(x => x.address), c.manifest.routing.poolSwapTest,
      c.manifest.network.uniswapV4.poolManager, c.manifest.network.uniswapV4.quoter, c.manifest.network.uniswapV4.stateView];
    const codes = await Promise.all(addresses.map(address => this.client.getCode({ address })));
    if (codes.some(code => !code || code === '0x')) throw Error('A required contract has no deployed code. Transactions are disabled.');
    const [hookManager, routerManager, maximum] = await Promise.all([
      this.client.readContract({ address: c.hook.address, abi: c.abis[c.hook.name], functionName: 'poolManager' }),
      this.client.readContract({ address: c.manifest.routing.poolSwapTest, abi: c.abis.PoolSwapTest, functionName: 'manager' }),
      this.client.readContract({ address: c.hook.address, abi: c.abis[c.hook.name], functionName: 'MAX_SWAPS_PER_BLOCK' }),
    ]);
    if (String(hookManager).toLowerCase() !== c.manifest.network.uniswapV4.poolManager.toLowerCase() || String(routerManager).toLowerCase() !== c.manifest.network.uniswapV4.poolManager.toLowerCase() || Number(maximum) !== 3) throw Error('Deployed pool manager or limit does not match this launch.');
    this.verified = true;
  }
  async slots(blockNumber?: bigint): Promise<WindowState> {
    const c = this.config;
    const [block, used, remaining] = await this.client.readContract({ address: c.hook.address, abi: c.abis[c.hook.name], functionName: 'swapsInBlock', args: [c.poolId], blockNumber }) as [bigint, number, number];
    if (used + remaining !== 3 || used < 0 || remaining < 0 || (blockNumber !== undefined && block !== blockNumber)) throw Error('Inconsistent block state. Refresh to try again.');
    return { block, used, remaining };
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.verified) await this.verify();
    const c = this.config, block = await this.client.getBlockNumber();
    const [slots, slot0, decimals, supply, symbol] = await Promise.all([
      this.slots(block),
      this.client.readContract({ address: c.manifest.network.uniswapV4.stateView, abi: c.abis.StateView, functionName: 'getSlot0', args: [c.poolId], blockNumber: block }),
      this.client.readContract({ address: c.token.address, abi: c.abis[c.token.name], functionName: 'decimals', blockNumber: block }),
      this.client.readContract({ address: c.token.address, abi: c.abis[c.token.name], functionName: 'totalSupply', blockNumber: block }),
      this.client.readContract({ address: c.token.address, abi: c.abis[c.token.name], functionName: 'symbol', blockNumber: block }),
    ]);
    if (Number(decimals) !== c.manifest.token.decimals || symbol !== c.manifest.token.symbol) throw Error('Token metadata does not match the deployment.');
    return { ...slots, sqrtPrice: (slot0 as [bigint])[0], decimals: Number(decimals), supply: supply as bigint, symbol: String(symbol), at: Date.now() };
  }
  async balances(account: Address): Promise<Balance> {
    const c = this.config;
    const [eth, token, allowance] = await Promise.all([
      this.client.getBalance({ address: account }),
      this.client.readContract({ address: c.token.address, abi: c.abis[c.token.name], functionName: 'balanceOf', args: [account] }),
      this.client.readContract({ address: c.token.address, abi: c.abis[c.token.name], functionName: 'allowance', args: [account, c.manifest.routing.poolSwapTest] }),
    ]);
    return { eth, token: token as bigint, allowance: allowance as bigint };
  }
  async history(toBlock: bigint) {
    const c = this.config;
    const start = toBlock - 119n > BigInt(c.manifest.deploymentBlock) ? toBlock - 119n : BigInt(c.manifest.deploymentBlock);
    const rows = new Map<string, HistoryRow>();
    const event = c.abis[c.hook.name].find(x => x.type === 'event' && x.name === 'SwapCounted') as AbiEvent;
    for (let fromBlock = start; fromBlock <= toBlock; fromBlock += 30n) {
      const end = fromBlock + 29n < toBlock ? fromBlock + 29n : toBlock;
      const logs = await this.client.getLogs({ address: c.hook.address, event, args: { poolId: c.poolId }, fromBlock, toBlock: end, strict: true });
      for (const log of logs) {
        if (log.removed || !log.transactionHash) continue;
        const args = log.args as { poolId: Hex; blockNumber: bigint; count: number };
        if (args.poolId.toLowerCase() !== c.poolId.toLowerCase() || args.blockNumber !== log.blockNumber) continue;
        const id = args.blockNumber.toString();
        const row = rows.get(id) ?? { block: args.blockNumber, count: 0, transactions: [] };
        row.count = Math.max(row.count, args.count);
        if (!row.transactions.includes(log.transactionHash)) row.transactions.push(log.transactionHash);
        rows.set(id, row);
      }
    }
    return { from: start, to: toBlock, rows: [...rows.values()].sort((a, b) => a.block > b.block ? -1 : 1) };
  }
  async identity(provider: Provider, account: Address) {
    const [chain, accounts] = await Promise.all([provider.request({ method: 'eth_chainId' }), provider.request({ method: 'eth_accounts' })]);
    if (Number(chain) !== this.config.manifest.chainId) throw Error(`Switch to ${this.config.chain.name} before continuing.`);
    if (accounts[0]?.toLowerCase() !== account.toLowerCase()) throw Error('Wallet account changed. Reconnect and get a new quote.');
  }
  async quote(account: Address, buy: boolean, amount: bigint, bps: number, hookData: Hex): Promise<Quote> {
    const c = this.config, snapshot = await this.snapshot();
    if (!snapshot.remaining) throw Error('RateLimited');
    if (!snapshot.sqrtPrice) throw Error('Pool is not initialized. Swapping is unavailable.');
    const response = await this.client.simulateContract({ account, address: c.manifest.network.uniswapV4.quoter, abi: [...c.abis.V4Quoter, ...c.abis[c.hook.name], ...c.abis.PoolSwapTest.filter(a => a.type === 'error')], functionName: 'quoteExactInputSingle', args: [{ poolKey: c.poolKey, zeroForOne: buy, exactAmount: amount, hookData }], blockNumber: snapshot.block });
    const output = (response.result as [bigint, bigint])[0];
    if (output <= 0n) throw Error('No output is available for this amount. Try a different amount.');
    return { amount, output, sqrtLimit: priceLimit(snapshot.sqrtPrice, buy, bps), block: snapshot.block, at: Date.now(), buy, hookData, bps, account };
  }
  async approve(provider: Provider, quote: Quote) {
    await this.identity(provider, quote.account);
    await this.verify();
    if (quote.buy) throw Error('ETH needs no approval.');
    const c = this.config;
    const { request } = await this.client.simulateContract({ account: quote.account, address: c.token.address, abi: c.abis[c.token.name], functionName: 'approve', args: [c.manifest.routing.poolSwapTest, quote.amount] });
    await this.identity(provider, quote.account);
    return createWalletClient({ chain: c.chain, transport: custom(provider) }).writeContract(request);
  }
  async simulate(provider: Provider, quote: Quote) {
    await this.identity(provider, quote.account);
    await this.verify();
    if (Date.now() - quote.at > 60000) throw Error('Quote expired. Get a new quote before sending.');
    const slots = await this.slots();
    if (!slots.remaining) throw Error('RateLimited');
    const balance = await this.balances(quote.account);
    if ((quote.buy ? balance.eth : balance.token) < quote.amount) throw Error('Insufficient balance. Reduce the input amount.');
    if (!quote.buy && balance.allowance < quote.amount) throw Error('Approve RATE for PoolSwapTest before simulating.');
    const c = this.config;
    const simulation = await this.client.simulateContract({ account: quote.account, address: c.manifest.routing.poolSwapTest, abi: [...c.abis.PoolSwapTest, ...c.abis[c.hook.name].filter(a => a.type === 'error')], functionName: 'swap', args: [c.poolKey, { zeroForOne: quote.buy, amountSpecified: -quote.amount, sqrtPriceLimitX96: quote.sqrtLimit }, { takeClaims: false, settleUsingBurn: false }, quote.hookData], value: quote.buy ? quote.amount : 0n });
    const amounts = decodeDelta(simulation.result as bigint, quote.buy);
    if (amounts.input <= 0n || amounts.input > quote.amount || amounts.output <= 0n) throw Error('Simulation produced no usable swap. Adjust the amount or price limit.');
    return { request: simulation.request, amounts, slots };
  }
  async send(provider: Provider, quote: Quote) {
    // Re-simulate immediately before the wallet prompt; the displayed review is not reused.
    const simulation = await this.simulate(provider, quote);
    await this.identity(provider, quote.account);
    return createWalletClient({ chain: this.config.chain, transport: custom(provider) }).writeContract(simulation.request);
  }
  async receipt(hash: Hex) {
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 180000 });
    if (receipt.status !== 'success') throw Error('Transaction reverted. No swap was counted. Refresh and get a new quote.');
    return receipt;
  }
}
