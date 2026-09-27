import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, encodeErrorResult, keccak256, toHex, parseAbi, type Abi, type Hex } from 'viem';
import { priceLimit, decodeDelta, parseAmount } from '../src/chain';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('dist/imd-deployment.json', root), 'utf8'));
const abis: Record<string, Abi> = {};
for (const c of manifest.contracts) abis[c.name] = JSON.parse(await readFile(new URL(`dist/${c.abiPath}`, root), 'utf8'));
for (const [name, path] of Object.entries(manifest.routing.protocolAbis)) abis[name] = JSON.parse(await readFile(new URL(`dist/${path}`, root), 'utf8'));
const allAbi = Object.values(abis).flat();
const hook = manifest.contracts.find((c: { name: string }) => c.name === manifest.hook).address;
const token = manifest.contracts.find((c: { name: string }) => c.name === manifest.token.contract).address;
const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [manifest.pool.pairedCurrency, token, manifest.pool.fee, manifest.pool.tickSpacing, hook]));
const account = '0x1111111111111111111111111111111111111111';
const txHash = ('0x' + 'ab'.repeat(32)) as Hex;
const blockHash = ('0x' + 'cd'.repeat(32)) as Hex;
const block = BigInt(manifest.deploymentBlock + 200);
const results: { name: string; result: string; detail?: unknown }[] = [];
const filesSeen = new Set<string>();
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname).replace(/^\/preview\//, '');
    if (!path || path === '/') path = 'index.html';
    if (path.includes('..') || path.startsWith('/')) throw Error('Path out of bounds');
    const body = await readFile(new URL(`dist/${path}`, root));
    filesSeen.add(path);
    res.writeHead(200, { 'Content-Type': path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/json' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
const address = server.address() as { port: number };
const url = `http://127.0.0.1:${address.port}/preview/`;
await mkdir(new URL('test/scratch/browser/', root), { recursive: true });
await writeFile(new URL('test/scratch/browser/preview.json', root), JSON.stringify({ url }));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });
let page: Page;
type MockState = { used: number; balance: bigint; allowance: bigint; missingCode: boolean; rpcError: boolean; historyError: boolean; emptyHistory: boolean; swapRevert: boolean; receiptRevert: boolean; partial: boolean; quoteDelay: number; chainId: number; sent: number; calls: { method: string; params: any[] }[] };
let state: MockState;
const reset = () => { state = { used: 2, balance: 10n ** 22n, allowance: 0n, missingCode: false, rpcError: false, historyError: false, emptyHistory: false, swapRevert: false, receiptRevert: false, partial: false, quoteDelay: 0, chainId: manifest.chainId, sent: 0, calls: [] }; };
function log(count: number, number: bigint) {
  return { address: hook, blockHash, blockNumber: toHex(number), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [number, count]), logIndex: toHex(count), transactionIndex: '0x0', transactionHash: ('0x' + String(count).repeat(64)), removed: false,
    topics: encodeEventTopics({ abi: abis.SwapRateLimitHook, eventName: 'SwapCounted', args: { poolId } }) };
}
async function rpc(method: string, params: any[] = []) {
  state.calls.push({ method, params });
  if (state.rpcError) throw Error('Mock RPC offline');
  if (method === 'eth_chainId') return toHex(state.chainId);
  if (method === 'eth_blockNumber') return toHex(block);
  if (method === 'eth_getCode') return state.missingCode ? '0x' : '0x6001600055';
  if (method === 'eth_getBalance') return toHex(state.balance);
  if (method === 'eth_getLogs') {
    if (state.historyError) throw Error('Mock history unavailable');
    assert.equal(params[0].address.toLowerCase(), hook);
    assert.equal(params[0].topics[1], poolId);
    if (state.emptyHistory) return [];
    const logs = [log(1, block - 1n), log(2, block - 1n), log(1, block - 2n), log(2, block - 2n), log(3, block - 2n)];
    return logs.filter(l => BigInt(l.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(l.blockNumber) <= BigInt(params[0].toBlock));
  }
  if (method === 'eth_call') {
    const { functionName, args = [] } = decodeFunctionData({ abi: allAbi, data: params[0].data });
    let result: any;
    switch (functionName) {
      case 'poolManager': case 'manager': result = manifest.network.uniswapV4.poolManager; break;
      case 'MAX_SWAPS_PER_BLOCK': result = 3; break;
      case 'swapsInBlock': assert.equal(args[0], poolId); result = [block, state.used, 3 - state.used]; break;
      case 'getSlot0': assert.equal(params[0].to.toLowerCase(), manifest.network.uniswapV4.stateView); result = [BigInt(manifest.pool.initialPrice), 138120, 0, 3000]; break;
      case 'decimals': result = 18; break;
      case 'symbol': result = 'RATE'; break;
      case 'totalSupply': result = 1000000000n * 10n ** 18n; break;
      case 'balanceOf': result = state.balance; break;
      case 'allowance': assert.equal(String(args[1]).toLowerCase(), manifest.routing.poolSwapTest); result = state.allowance; break;
      case 'approve': assert.equal(params[0].to.toLowerCase(), token); assert.equal(String(args[0]).toLowerCase(), manifest.routing.poolSwapTest); result = true; break;
      case 'quoteExactInputSingle': {
        assert.equal(params[0].to.toLowerCase(), manifest.network.uniswapV4.quoter);
        const q = args[0] as any;
        assert.equal(q.poolKey.hooks.toLowerCase(), hook); assert.equal(q.poolKey.currency1.toLowerCase(), token);
        if (state.quoteDelay) await new Promise(r => setTimeout(r, state.quoteDelay));
        result = [q.zeroForOne ? q.exactAmount * 995000n : q.exactAmount / 995000n, 120000n]; break;
      }
      case 'swap': {
        assert.equal(params[0].to.toLowerCase(), manifest.routing.poolSwapTest);
        if (state.swapRevert) throw { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: abis.PoolSwapTest, errorName: 'WrappedError', args: [hook, '0x12345678', encodeErrorResult({ abi: abis.SwapRateLimitHook, errorName: 'RateLimited', args: [block] }), '0x'] }) };
        const p = args[1] as any;
        assert.ok(p.amountSpecified < 0n); assert.deepEqual(args[2], { takeClaims: false, settleUsingBurn: false });
        assert.ok(p.sqrtPriceLimitX96 > 4295128739n);
        const amount = -p.amountSpecified / (state.partial ? 2n : 1n), out = p.zeroForOne ? amount * 995000n : amount / 995000n;
        const d0 = p.zeroForOne ? -amount : out, d1 = p.zeroForOne ? out : -amount;
        result = (d0 << 128n) | BigInt.asUintN(128, d1); break;
      }
      default: throw Error(`Unmocked call ${functionName}`);
    }
    return encodeFunctionResult({ abi: allAbi, functionName, result });
  }
  if (method === 'eth_getTransactionReceipt') return { transactionHash: params[0], transactionIndex: '0x0', blockHash, blockNumber: toHex(block), from: account, to: manifest.routing.poolSwapTest, cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: state.receiptRevert ? '0x0' : '0x1', effectiveGasPrice: '0x3b9aca00', type: '0x2' };
  if (method === 'eth_getTransactionByHash') return { hash: params[0], blockHash, blockNumber: toHex(block), transactionIndex: '0x0', from: account, to: manifest.routing.poolSwapTest, value: '0x0', gas: '0x30000', gasPrice: '0x3b9aca00', input: '0x', nonce: '0x0', type: '0x0', v: '0x1', r: '0x1', s: '0x1' };
  if (method === 'eth_getBlockByNumber') return { hash: blockHash, number: toHex(block), timestamp: toHex(Math.floor(Date.now() / 1000)), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x186a0', baseFeePerGas: '0x3b9aca00', difficulty: '0x0', extraData: '0x', miner: account, nonce: '0x0000000000000000', parentHash: blockHash, receiptsRoot: blockHash, sha3Uncles: blockHash, size: '0x100', stateRoot: blockHash, transactionsRoot: blockHash, uncles: [], logsBloom: '0x' + '00'.repeat(256) };
  throw Error(`Unmocked RPC ${method}`);
}
async function start(wallet = true, chain = manifest.chainId, connected = false, mock = true) {
  if (page) await page.context().close();
  reset();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  // tsx preserves function names using a helper; serialized browser callbacks need it too.
  await page.addInitScript('window.__name = function (fn) { return fn; };');
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  await page.exposeFunction('recordSend', (tx: any) => {
    state.sent++;
    const { functionName, args } = decodeFunctionData({ abi: allAbi, data: tx.data });
    if (functionName === 'approve') state.allowance = (args as any[])[1];
  });
  if (mock) await page.route('https://**/*', async route => {
    const payload = route.request().postDataJSON();
    if (!payload?.method) { await route.abort(); return; }
    try { const result = await rpc(payload.method, payload.params); await route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, result } }); }
    catch (e) { await route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, error: { code: (e as any).code ?? -32000, message: (e as any).message, data: (e as any).data } } }); }
  });
  if (wallet) await page.addInitScript(({ chain, connected, account, txHash }) => {
    const listeners: Record<string, Function[]> = {};
    const w = window as any;
    w.mockWallet = { chain, accounts: connected ? [account] : [], reject: false, unknown: false, added: false, requests: [], emit: (event: string) => (listeners[event] ?? []).forEach(fn => fn()) };
    w.ethereum = { on: (e: string, fn: Function) => (listeners[e] ??= []).push(fn), removeListener: (e: string, fn: Function) => { listeners[e] = (listeners[e] ?? []).filter(f => f !== fn); }, request: async ({ method, params }: any) => {
      const m = w.mockWallet; m.requests.push({ method, params });
      if (method === 'eth_chainId') return '0x' + m.chain.toString(16);
      if (method === 'eth_accounts') return m.accounts;
      if (m.reject) throw { code: 4001, message: 'User rejected' };
      if (method === 'eth_requestAccounts') { m.accounts = [account]; return m.accounts; }
      if (method === 'wallet_switchEthereumChain') { if (m.unknown && !m.added) throw { code: 4902, message: 'Unknown chain' }; m.chain = parseInt(params[0].chainId); m.emit('chainChanged'); return null; }
      if (method === 'wallet_addEthereumChain') { m.added = true; return null; }
      if (method === 'eth_sendTransaction') { await w.recordSend(params[0]); return txHash; }
      throw Error('Unexpected wallet method: ' + method);
    } };
  }, { chain, connected, account, txHash });
  await page.goto(url);
  await page.getByRole('heading', { name: 'Three swaps. Every block.' }).waitFor();
  return failures;
}
async function loaded() { await page.getByText('1 of 3 slots available.', { exact: false }).waitFor(); }
async function connected() { await loaded(); await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect' }).waitFor(); }
async function quote() { await page.getByLabel('You pay up to').fill('0.001'); await page.getByRole('button', { name: /^Get quote/ }).click(); await page.getByRole('button', { name: /^Simulate swap$/ }).waitFor(); }
async function check(name: string, task: () => Promise<unknown>) {
  try { const detail = await task(); results.push({ name, result: 'pass', ...(detail ? { detail } : {}) }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, result: 'FAIL', detail: String(e) }); await page?.screenshot({ path: new URL('test/scratch/failure.png', root).pathname, fullPage: true }); throw e; }
}
try {
  await check('Amount precision, signed delta and integer price-limit boundaries', async () => {
    assert.throws(() => parseAmount('0.0000000000000000001', 18)); assert.throws(() => parseAmount('-1', 18)); assert.throws(() => parseAmount('1e2', 18)); assert.equal(parseAmount('.001', 18), 10n ** 15n);
    const p = BigInt(manifest.pool.initialPrice);
    assert.ok(priceLimit(p, true, 50) < p && priceLimit(p, false, 50) > p);
    assert.deepEqual(decodeDelta((-10n << 128n) | 50n, true), { input: 10n, output: 50n });
  });
  await check('Disconnected, live counter, per-block grouping and limit flag', async () => {
    const failures = await start(); await loaded();
    assert.equal(await page.getByRole('button', { name: 'Connect wallet to quote' }).count(), 1);
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.equal(await page.getByText('Limit reached', { exact: true }).count(), 1);
    assert.deepEqual(failures, []);
    await page.screenshot({ path: new URL('docs/evidence/desktop.png', root).pathname, fullPage: true });
  });
  await check('Keyboard navigation, focused amount field and automated accessibility', async () => {
    await page.keyboard.press('Tab'); assert.equal(await page.locator(':focus').innerText(), 'Skip to content');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 30; i++) { if (await page.locator('#amount').evaluate(el => el === document.activeElement)) break; await page.keyboard.press('Tab'); }
    assert.equal(await page.locator('#amount').evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: new URL('docs/evidence/focus.png', root).pathname, fullPage: true });
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    return { rulesPassed: axe.passes.length, violations: axe.violations.length };
  });
  await check('Measured rendered text, input boundaries and focus contrast', async () => {
    const pairs = await page.evaluate(() => {
      const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (color: string) => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0);
      const bg = (el: Element): string => { const color = getComputedStyle(el).backgroundColor; return color === 'rgba(0, 0, 0, 0)' ? bg(el.parentElement!) : color; };
      const pairs = [['.intro-copy p', 'color', 4.5], ['.swap-panel .subtext', 'color', 4.5], ['.primary', 'color', 4.5], ['.slot.filled b', 'color', 4.5], ['.limit-tag', 'color', 4.5], ['.amount-box', 'borderTopColor', 3], ['.percent-input', 'borderTopColor', 3], ['#amount', 'outlineColor', 3]] as const;
      return pairs.map(([selector, property, minimum]) => { const el = document.querySelector(selector)!; const foreground = getComputedStyle(el)[property]; const background = bg(el); const a = lum(foreground), b = lum(background); return { selector, property, foreground, background, minimum, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }; });
    });
    for (const p of pairs) assert.ok(p.ratio >= p.minimum, `${p.selector}: ${p.ratio}`);
    await writeFile(new URL('docs/evidence/contrast.json', root), JSON.stringify(pairs, null, 2) + '\n');
    return pairs.map(p => ({ selector: p.selector, ratio: Number(p.ratio.toFixed(2)) }));
  });
  await check('Mobile 320px, 390px and intermediate 820px reflow', async () => {
    for (const width of [320, 390, 820]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`);
      await page.screenshot({ path: new URL(`docs/evidence/viewport-${width}.png`, root).pathname, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overflow at 200% text size');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('button').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await check('Missing-wallet recovery and rejected wallet connection', async () => {
    await start(false); await loaded(); await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'No browser wallet found' }).waitFor();
    await start(); await loaded(); await page.evaluate(() => { (window as any).mockWallet.reject = true; }); await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Request declined' }).waitFor();
  });
  await check('Wrong chain and 4902 add-chain fallback uses exact network parameters', async () => {
    await start(true, 1); await connected();
    assert.ok(await page.getByRole('button', { name: /^Get quote/ }).isDisabled());
    await page.evaluate(() => { (window as any).mockWallet.unknown = true; });
    await page.getByRole('button', { name: 'Switch to Sepolia' }).click();
    await page.getByRole('button', { name: /^Get quote/ }).waitFor();
    await page.waitForFunction(() => !(document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled);
    const request = await page.evaluate(() => (window as any).mockWallet.requests.find((r: any) => r.method === 'wallet_addEthereumChain'));
    assert.deepEqual(request.params, [manifest.walletAddChain]);
  });
  await check('Validation focuses invalid field; full block disables quote', async () => {
    await start(); await connected(); await page.getByRole('button', { name: /^Get quote/ }).click();
    assert.equal(await page.locator('#amount').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#amount').evaluate(el => el === document.activeElement), true);
    state.used = 3; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByText('0 of 3 slots available.', { exact: false }).waitFor();
    assert.ok(await page.getByRole('button', { name: /^Get quote/ }).isDisabled());
  });
  await check('ETH buy quotes, simulates and submits correct signed swap without approval', async () => {
    await start(); await connected(); await quote();
    await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByRole('heading', { name: 'Review your swap' }).waitFor();
    await page.screenshot({ path: new URL('docs/evidence/swap-review.png', root).pathname, fullPage: true });
    await page.getByRole('button', { name: /^Confirm swap in wallet/ }).click(); await page.getByText('Swap confirmed', { exact: true }).waitFor();
    const sends = await page.evaluate(() => (window as any).mockWallet.requests.filter((r: any) => r.method === 'eth_sendTransaction'));
    assert.equal(sends.length, 1); assert.equal(sends[0].params[0].to.toLowerCase(), manifest.routing.poolSwapTest); assert.equal(BigInt(sends[0].params[0].value), 10n ** 15n);
    const decoded = decodeFunctionData({ abi: abis.PoolSwapTest, data: sends[0].params[0].data });
    assert.equal((decoded.args![1] as any).amountSpecified, -(10n ** 15n)); assert.equal((decoded.args![1] as any).zeroForOne, true);
  });
  await check('RATE sell requires exact approval to PoolSwapTest and then signs with zero ETH', async () => {
    await start(); await connected(); await page.getByRole('button', { name: 'Sell RATE', exact: true }).click();
    await page.getByLabel('You pay up to').fill('10'); await page.getByRole('button', { name: /^Get quote/ }).click(); await page.getByRole('button', { name: '1. Approve RATE' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '2. Simulate swap' }).isDisabled());
    await page.getByRole('button', { name: '1. Approve RATE' }).click(); await page.getByText('Approval confirmed', { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '2. Simulate swap' && !b.disabled));
    await page.getByRole('button', { name: '2. Simulate swap' }).click(); await page.getByRole('heading', { name: 'Review your swap' }).waitFor(); await page.getByRole('button', { name: /^Confirm swap in wallet/ }).click(); await page.getByText('Swap confirmed', { exact: true }).waitFor();
    const sends = await page.evaluate(() => (window as any).mockWallet.requests.filter((r: any) => r.method === 'eth_sendTransaction'));
    assert.equal(sends.length, 2);
    const approval = decodeFunctionData({ abi: abis.Ratelimit, data: sends[0].params[0].data });
    assert.equal(String(approval.args![0]).toLowerCase(), manifest.routing.poolSwapTest); assert.equal(approval.args![1], 10n ** 19n);
    assert.equal(BigInt(sends[1].params[0].value ?? '0x0'), 0n);
    assert.equal((decodeFunctionData({ abi: abis.PoolSwapTest, data: sends[1].params[0].data }).args![1] as any).zeroForOne, false);
  });
  await check('Nested RateLimited simulation error prevents wallet submission', async () => {
    await start(); await connected(); await quote(); state.swapRevert = true;
    await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'This block has no slots left' }).waitFor(); assert.equal(state.sent, 0);
  });
  await check('Slots rechecked before signing, even after a successful review', async () => {
    await start(); await connected(); await quote(); await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByRole('heading', { name: 'Review your swap' }).waitFor(); state.used = 3;
    await page.getByRole('button', { name: /^Confirm swap in wallet/ }).click(); await page.getByRole('alert').filter({ hasText: 'This block has no slots left' }).waitFor(); assert.equal(state.sent, 0);
  });
  await check('Partial fill is disclosed; rejected signature is recoverable', async () => {
    await start(); await connected(); await quote(); state.partial = true; await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByText(/Partial fill: unused input/).waitFor();
    await page.evaluate(() => { (window as any).mockWallet.reject = true; }); await page.getByRole('button', { name: /^Confirm swap in wallet/ }).click(); await page.getByRole('alert').filter({ hasText: 'Request declined' }).waitFor(); assert.equal(state.sent, 0);
  });
  await check('Reverted transaction receipt is marked failed, never confirmed', async () => {
    await start(); await connected(); await quote();
    await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByRole('heading', { name: 'Review your swap' }).waitFor();
    state.receiptRevert = true;
    await page.getByRole('button', { name: /^Confirm swap in wallet/ }).click();
    await page.getByText('Swap failed', { exact: true }).waitFor();
    assert.equal(await page.getByText('Swap confirmed', { exact: true }).count(), 0);
  });
  await check('Hook data is forwarded; changing amount invalidates quote', async () => {
    await start(); await connected(); await page.getByText('Advanced swap details', { exact: true }).click();
    await page.getByLabel('Hook data (hex)', { exact: true }).fill('0x1234');
    await quote(); await page.getByRole('button', { name: 'Simulate swap', exact: true }).click(); await page.getByRole('heading', { name: 'Review your swap' }).waitFor();
    const swaps = state.calls.filter(c => c.method === 'eth_call').map(c => decodeFunctionData({ abi: allAbi, data: c.params[0].data })).filter(c => c.functionName === 'swap');
    assert.equal(swaps.at(-1)!.args![3], '0x1234');
    await page.getByLabel('You pay up to').fill('0.002');
    assert.equal(await page.getByRole('button', { name: /^Confirm swap in wallet/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Simulate swap', exact: true }).count(), 0);
  });
  await check('Account change invalidates outstanding quote; expired quote cannot sign', async () => {
    await start(); await connected(); await quote();
    await page.evaluate(() => { const w = (window as any).mockWallet; w.accounts = ['0x2222222222222222222222222222222222222222']; w.emit('accountsChanged'); });
    await page.getByRole('button', { name: /^Get quote/ }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Simulate swap', exact: true }).count(), 0);
    await quote(); await page.clock.install(); await page.clock.fastForward(61000);
    await page.getByText(/Expired — get a new quote/).waitFor(); assert.ok(await page.getByRole('button', { name: 'Simulate swap', exact: true }).isDisabled());
  });
  await check('Empty history, history failure and missing deployed code', async () => {
    await start(); await loaded(); state.emptyHistory = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByText('No swaps in this window', { exact: true }).waitFor();
    state.historyError = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByRole('button', { name: 'Retry history' }).waitFor();
    await page.reload(); state.missingCode = true; await page.getByText('Pool data unavailable', { exact: true }).waitFor();
    assert.equal(state.sent, 0);
  });
  await check('RPC outage never displays a fabricated zero counter', async () => {
    await start(); await loaded(); state.rpcError = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByText('Pool data unavailable', { exact: true }).waitFor();
    assert.equal(await page.locator('.big-count > span').first().textContent(), '—');
  });
  await check('Corrupted ABI is rejected before pool reads or signing', async () => {
    await start();
    await page.route('**/abi/Ratelimit.json', route => route.fulfill({ json: [] }));
    await page.reload(); await page.getByRole('heading', { name: 'Unable to verify deployment' }).waitFor(); assert.equal(state.sent, 0);
  });
  await check('Live public-RPC browser read and static subpath resources', async () => {
    const failures = await start(false, manifest.chainId, false, false);
    await page.getByText('Live · refreshes every 12s', { exact: true }).waitFor({ timeout: 45000 });
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    await page.screenshot({ path: new URL('docs/evidence/live-desktop.png', root).pathname, fullPage: true });
    assert.deepEqual(failures, []);
    return { blockText: await page.locator('.block-meta').innerText(), filesLoaded: [...filesSeen].sort() };
  });
  if (process.env.REVIEW_HOLD === '1') {
    console.log(`Review preview available for 5 minutes: ${url}`);
    await new Promise(r => setTimeout(r, 300000));
  }
} finally {
  await writeFile(new URL('docs/evidence/interactions.json', root), JSON.stringify({ checkedAt: new Date().toISOString(), browser: await browser.version(), urlPath: '/preview/', transactions: 'All signatures and transaction receipts mocked; no broadcast to Sepolia.', results }, null, 2) + '\n');
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
