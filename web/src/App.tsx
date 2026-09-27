import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { loadConfig, type Config } from './config';
import { ChainService, errorMessage, parseAmount, shorten, switchChain, units, type Balance, type Quote, type Snapshot } from './chain';

type History = Awaited<ReturnType<ChainService['history']>>;
type Review = Awaited<ReturnType<ChainService['simulate']>>;
type Transaction = { hash: Hex; kind: 'approval' | 'swap'; state: 'pending' | 'confirmed' | 'failed' | 'unknown' };
const Arrow = () => <span aria-hidden="true">↗</span>;
function Slots({ used, large = false }: { used: number | undefined; large?: boolean }) {
  return <div className={`slots ${large ? 'slots-large' : ''}`} aria-hidden="true">{[0, 1, 2].map(i => <div key={i} className={used !== undefined && i < used ? 'slot filled' : 'slot'}>{large && <><span>0{i + 1}</span><b>{used === undefined ? '—' : i < used ? 'Counted' : 'Available'}</b></>}</div>)}</div>;
}
export function App() {
  const [config, setConfig] = useState<Config>();
  const [fatal, setFatal] = useState('');
  useEffect(() => { loadConfig().then(setConfig).catch(e => setFatal(errorMessage(e))); }, []);
  if (!config) return <div className="startup"><div className="brand">ratelimit<span className="brand-mark" aria-hidden="true">|||</span></div><h1>{fatal ? 'Unable to verify deployment' : 'Opening the observatory…'}</h1><p role={fatal ? 'alert' : 'status'}>{fatal || 'Loading deployment configuration and checking ABI integrity.'}</p>{fatal && <button onClick={() => location.reload()}>Reload deployment</button>}</div>;
  return <Dashboard config={config} />;
}
function Dashboard({ config: c }: { config: Config }) {
  const [service] = useState(() => new ChainService(c));
  const [account, setAccount] = useState<Address>();
  const [walletChain, setWalletChain] = useState<number>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [balance, setBalance] = useState<Balance>();
  const [history, setHistory] = useState<History>();
  const [historyError, setHistoryError] = useState('');
  const [readError, setReadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState('');
  const [limit, setLimit] = useState('0.50');
  const [hookData, setHookData] = useState('0x');
  const [quote, setQuote] = useState<Quote>();
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [transaction, setTransaction] = useState<Transaction>();
  const generation = useRef(0);
  const wrongChain = !!account && walletChain !== c.chain.id;
  const pending = transaction?.state === 'pending' || transaction?.state === 'unknown';
  const stale = !snapshot || now - snapshot.at > 30000;
  const ready = !!account && !wrongChain && !!snapshot && !stale && service.verified && snapshot.sqrtPrice > 0n && !readError;
  const quoteExpired = !quote || now - quote.at > 60000;
  const needsApproval = !!quote && !buy && (!balance || balance.allowance < quote.amount);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);
  const invalidate = () => { generation.current++; setQuote(undefined); setReview(undefined); setError(''); setFieldError(''); setStatus(''); };
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    // Wait until the submitting fieldset is enabled again before restoring focus.
    if (fieldError && !busy) document.getElementById(fieldError)?.focus();
  }, [fieldError, busy]);
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    let disposed = false;
    const update = async () => {
      generation.current++;
      setQuote(undefined); setReview(undefined); setBalance(undefined);
      try {
        const [accounts, chain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
        if (!disposed) { setAccount(accounts[0]); setWalletChain(Number(chain)); }
      } catch { if (!disposed) { setAccount(undefined); setWalletChain(undefined); } }
    };
    const disconnect = () => { generation.current++; setAccount(undefined); setWalletChain(undefined); setQuote(undefined); setReview(undefined); setBalance(undefined); };
    void update();
    provider.on?.('accountsChanged', update); provider.on?.('chainChanged', update); provider.on?.('disconnect', disconnect);
    return () => { disposed = true; provider.removeListener?.('accountsChanged', update); provider.removeListener?.('chainChanged', update); provider.removeListener?.('disconnect', disconnect); };
  }, []);
  useEffect(() => {
    let disposed = false, running = false;
    async function poll() {
      if (running) return;
      running = true;
      setLoading(true);
      try {
        const state = await service.snapshot();
        if (disposed) return;
        setSnapshot(state); setReadError('');
        if (account) {
          try { const balances = await service.balances(account); if (!disposed) setBalance(balances); }
          catch { if (!disposed) setBalance(undefined); }
        }
        try { const rows = await service.history(state.block); if (!disposed) { setHistory(rows); setHistoryError(''); } }
        catch (e) { if (!disposed) { setHistory(undefined); setHistoryError(errorMessage(e, c)); } }
      } catch (e) { if (!disposed) { setReadError(errorMessage(e, c)); setSnapshot(undefined); setBalance(undefined); setQuote(undefined); setReview(undefined); } }
      finally { running = false; if (!disposed) setLoading(false); }
    }
    void poll();
    const id = setInterval(poll, 12000);
    return () => { disposed = true; clearInterval(id); };
  }, [account, service, c, refreshKey]);
  async function run(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(''); setFieldError('');
    try { await task(); } catch (e) { setError(errorMessage(e, c)); setReview(undefined); }
    finally { setBusy(''); }
  }
  async function connect() {
    await run('Connecting wallet…', async () => {
      const provider = window.ethereum;
      if (!provider) throw Error('No browser wallet found. Open this page in an Ethereum wallet browser or install a browser wallet, then reload.');
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const chain = await provider.request({ method: 'eth_chainId' });
      setAccount(accounts[0]); setWalletChain(Number(chain)); invalidate();
      if (!accounts[0]) throw Error('No account selected. Choose an account in your wallet and reconnect.');
    });
  }
  async function changeNetwork() {
    await run('Switching network…', async () => {
      await switchChain(window.ethereum!, c);
      const chain = await window.ethereum!.request({ method: 'eth_chainId' });
      setWalletChain(Number(chain)); invalidate(); refresh();
    });
  }
  function validateInput() {
    let value: bigint;
    try { value = parseAmount(amount, buy ? c.chain.nativeCurrency.decimals : snapshot!.decimals); }
    catch (e) { setFieldError('amount'); document.getElementById('amount')?.focus(); throw e; }
    if (!/^\d+(\.\d{1,2})?$/.test(limit) || Number(limit) < 0.01 || Number(limit) > 5) {
      setFieldError('limit'); document.getElementById('limit')?.focus(); throw Error('Choose a price limit from 0.01% to 5%, using up to two decimal places.');
    }
    if (!/^0x([0-9a-fA-F]{2})*$/.test(hookData) || hookData.length > 2050) {
      setFieldError('hook-data'); document.getElementById('advanced')?.setAttribute('open', ''); document.getElementById('hook-data')?.focus(); throw Error('Enter hook data as 0x followed by pairs of hexadecimal digits, up to 1,024 bytes.');
    }
    if (balance && (buy ? balance.eth : balance.token) < value) throw Error(`Insufficient ${buy ? 'ETH' : 'RATE'}. Reduce the amount or fund your wallet.`);
    return { value, bps: Math.round(Number(limit) * 100) };
  }
  async function getQuote() {
    await run('Getting quote…', async () => {
      if (!ready || !account) throw Error('Connect on the launch network and wait for fresh pool data.');
      const { value, bps } = validateInput();
      setQuote(undefined); setReview(undefined);
      const id = generation.current;
      await service.identity(window.ethereum!, account);
      const result = await service.quote(account, buy, value, bps, hookData as Hex);
      if (id !== generation.current) return;
      setQuote(result); setStatus('Quote ready. Review the estimate and price limit.'); refresh();
    });
  }
  async function waitForReceipt(tx: Transaction) {
    try {
      await service.receipt(tx.hash);
      setTransaction({ ...tx, state: 'confirmed' });
      setStatus(tx.kind === 'approval' ? 'RATE approval confirmed. Simulate the swap to review its outcome.' : 'Swap confirmed. Pool activity and balances are refreshing.');
      if (tx.kind === 'swap') { setQuote(undefined); setReview(undefined); }
    } catch (e) {
      const message = errorMessage(e, c);
      setTransaction({ ...tx, state: /Transaction reverted/.test(message) ? 'failed' : 'unknown' });
      throw Error(message + (message.includes('reverted') ? '' : ' Confirmation is still unknown. Check the transaction before trying again.'));
    } finally { refresh(); }
  }
  async function approve() {
    if (!quote || !ready || quoteExpired || pending) return;
    await run('Approving RATE…', async () => {
      setStatus(`Confirm approval for ${units(quote.amount, snapshot!.decimals)} RATE in your wallet.`);
      const hash = await service.approve(window.ethereum!, quote);
      const tx: Transaction = { hash, kind: 'approval', state: 'pending' };
      setTransaction(tx); setStatus('Approval submitted. Waiting for confirmation…');
      await waitForReceipt(tx);
    });
  }
  async function simulate() {
    if (!quote || !ready || quoteExpired || pending) return;
    await run('Simulating swap…', async () => {
      const id = generation.current;
      const result = await service.simulate(window.ethereum!, quote);
      if (id !== generation.current) return;
      setReview(result); setStatus('Simulation passed. Review the amounts before sending.');
    });
  }
  async function send() {
    if (!quote || !review || !ready || quoteExpired || pending) return;
    await run('Sending swap…', async () => {
      setStatus('Rechecking slots and simulating. Confirm the swap in your wallet when prompted.');
      const hash = await service.send(window.ethereum!, quote);
      const tx: Transaction = { hash, kind: 'swap', state: 'pending' };
      setTransaction(tx); setStatus('Swap submitted. Waiting for confirmation…'); setReview(undefined);
      await waitForReceipt(tx);
    });
  }
  const inputSymbol = buy ? 'ETH' : 'RATE', outputSymbol = buy ? 'RATE' : 'ETH';
  const inDecimals = buy ? c.chain.nativeCurrency.decimals : snapshot?.decimals ?? c.manifest.token.decimals;
  const outDecimals = buy ? snapshot?.decimals ?? c.manifest.token.decimals : c.chain.nativeCurrency.decimals;
  const price = snapshot?.sqrtPrice ? (Number(snapshot.sqrtPrice) / 2 ** 96) ** 2 * 10 ** (c.chain.nativeCurrency.decimals - snapshot.decimals) : undefined;
  const explorer = c.manifest.network.explorer;
  const contractLinks = [...c.manifest.contracts, { name: 'PoolSwapTest', address: c.manifest.routing.poolSwapTest }, ...Object.entries(c.manifest.network.uniswapV4).map(([name, address]) => ({ name, address }))];
  return <>
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="site-header shell">
      <a className="brand" href="#main" aria-label="Ratelimit home">ratelimit<span className="brand-mark" aria-hidden="true">|||</span></a>
      <div className="header-actions"><span className="network-label"><span className="dot" />{c.chain.name} testnet</span>
        {account ? <><span className="account" title={account}>{shorten(account)}</span><button className="small-button" disabled={!!busy || pending} onClick={() => { generation.current++; setAccount(undefined); setQuote(undefined); setReview(undefined); setBalance(undefined); setStatus('Wallet disconnected from this page.'); }}>Disconnect</button></> : <button disabled={!!busy} onClick={connect}>Connect wallet <Arrow /></button>}
      </div>
    </header>
    <main id="main" className="shell">
      <section className="intro" aria-labelledby="page-title"><div><p className="eyebrow">Onchain experiment · 001</p><h1 id="page-title">Three swaps.<br /><span>Every block.</span></h1></div><div className="intro-copy"><p>A shared limit for the ETH / RATE pool.<br />Watch the slots fill, then try a swap.</p><a href="#how-it-works">How the limit works <span aria-hidden="true">↓</span></a></div></section>
      <div className="dashboard-grid">
        <div className="observatory">
          <section className="activity-panel" aria-labelledby="activity-title">
            <div className="section-heading"><h2 id="activity-title">The latest block</h2><span className={`live-label ${readError || stale ? 'muted' : ''}`}><span className="dot" />{readError ? 'Connection interrupted' : snapshot && !stale ? 'Live · refreshes every 12s' : loading ? 'Connecting…' : 'Data is stale'}</span></div>
            <div className="block-heading"><div><p className="eyebrow">Swaps used</p><div className="big-count"><span>{snapshot?.used ?? '—'}</span><span className="count-total">/ 3</span></div></div><div className="block-meta"><span className="eyebrow">Block number</span>{snapshot ? <a href={`${explorer}/block/${snapshot.block}`} target="_blank" rel="noreferrer">{snapshot.block.toLocaleString('en-US')} <Arrow /></a> : <span className="mono">Awaiting chain</span>}<small>{snapshot ? `Updated ${Math.max(0, Math.floor((now - snapshot.at) / 1000))}s ago` : 'Reading public RPCs'}</small></div></div>
            <Slots used={snapshot?.used} large />
            <div className="activity-footer"><p>{snapshot ? <><strong>{snapshot.remaining} of 3 slots available.</strong> {snapshot.remaining ? 'Shared by every trader.' : 'The next block opens 3 new slots.'}</> : 'The count will appear when the chain responds.'}</p><button className="text-button" disabled={loading} onClick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
            {readError && <div className="message error" role="alert"><strong>Pool data unavailable</strong><p>{readError}</p><p>Transactions stay disabled. Use Refresh to retry the configured public RPCs.</p></div>}
            {!!snapshot && snapshot.sqrtPrice === 0n && <p className="message warning">This pool is not initialized. Swaps are unavailable.</p>}
          </section>
          <div className="pool-stats"><div><span className="eyebrow">Pool price</span><p>{price ? `${price.toLocaleString('en-US', { maximumFractionDigits: 2 })} RATE` : '—'}<small>per 1 ETH · StateView</small></p></div><div><span className="eyebrow">LP fee</span><p>{c.poolKey.fee / 10000}%<small>ETH / RATE · Uniswap v4</small></p></div></div>
          <section className="history-section" aria-labelledby="history-title"><div className="section-heading"><div><h2 id="history-title">Block history</h2><p className="subtext">Recent SwapCounted events</p></div><span className="tag">Last 120 blocks</span></div>
            {historyError ? <div className="message error"><p role="alert">Event history could not load. {historyError}</p><button onClick={refresh}>Retry history</button></div> : !history ? <p className="empty-state">Loading recent blocks…</p> : history.rows.length === 0 ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">≋</span><strong>No swaps in this window</strong><p>Accepted swaps will appear here.<br />Try a swap or refresh after a new block.</p></div> : <div className="history-table"><table><caption className="sr-only">Blocks with accepted swaps in the queried window</caption><thead><tr><th scope="col">Block</th><th scope="col">Usage</th><th scope="col">Status / receipts</th></tr></thead><tbody>{history.rows.map(row => <tr key={String(row.block)}><td><a className="mono" href={`${explorer}/block/${row.block}`} target="_blank" rel="noreferrer">{row.block.toLocaleString('en-US')} <Arrow /></a></td><td><div className="usage"><Slots used={row.count} /><span>{row.count} / 3</span></div></td><td><span className={row.count === 3 ? 'limit-tag' : 'muted'}>{row.count === 3 ? 'Limit reached' : 'Within limit'}</span><div className="receipt-links">{row.transactions.map((tx, i) => <a key={tx} href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer" aria-label={`View transaction ${i + 1} in block ${row.block}`}>Tx {i + 1} <Arrow /></a>)}</div></td></tr>)}</tbody></table></div>}
            {history && <p className="history-note">Blocks {history.from.toLocaleString('en-US')}–{history.to.toLocaleString('en-US')}. Blocks with no events are omitted. Reverted swaps emit nothing.</p>}
          </section>
        </div>
        <section className="swap-panel" aria-labelledby="swap-title">
          <div className="section-heading"><h2 id="swap-title">Try the limit</h2><span className="tag">Test tokens only</span></div>
          <p className="subtext">Swap ETH and RATE on {c.chain.name}.</p>
          {wrongChain && <div className="message warning"><strong>Wrong network</strong><p>Switch your wallet to {c.chain.name} to swap.</p><button onClick={changeNetwork} disabled={!!busy}>Switch to {c.chain.name}</button></div>}
          <form onSubmit={event => { event.preventDefault(); if (!account) void connect(); else void getQuote(); }} noValidate>
            <fieldset disabled={!!busy || pending}><legend className="sr-only">Swap details</legend>
              <div className="direction-switch" aria-label="Swap direction"><button type="button" aria-pressed={buy} onClick={() => { setBuy(true); setAmount(''); invalidate(); }}>Buy RATE</button><button type="button" aria-pressed={!buy} onClick={() => { setBuy(false); setAmount(''); invalidate(); }}>Sell RATE</button></div>
              <div className="amount-box"><div className="field-heading"><label htmlFor="amount">You pay up to</label><span className="token-symbol"><span className="coin" aria-hidden="true">{buy ? 'Ξ' : 'R'}</span>{inputSymbol}</span></div><input id="amount" name="amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} aria-invalid={fieldError === 'amount'} aria-describedby={fieldError === 'amount' ? 'action-error' : 'balance'} onChange={e => { setAmount(e.target.value); invalidate(); }} /><p id="balance" className="subtext">{account ? balance ? `Balance: ${units(buy ? balance.eth : balance.token, inDecimals, 8)} ${inputSymbol}` : 'Balance unavailable · refresh to retry' : 'Connect a wallet to see your balance'}</p></div>
              <div className="quote-output"><span>Estimated receive</span><strong>{quote ? units(quote.output, outDecimals, 8) : '—'} <span>{outputSymbol}</span></strong><small>V4Quoter estimate before the price limit</small></div>
              <div className="limit-row"><label htmlFor="limit">Price movement limit</label><div className="percent-input"><input id="limit" name="price-limit" type="text" inputMode="decimal" value={limit} aria-invalid={fieldError === 'limit'} aria-describedby={fieldError === 'limit' ? 'action-error' : 'price-help'} onChange={e => { setLimit(e.target.value); invalidate(); }} /><span>%</span></div></div>
              <p id="price-help" className="fine-print">Limits the pool price movement from the quoted spot price. Swaps may partially fill. PoolSwapTest does not guarantee a minimum output or enforce a deadline.</p>
              <details id="advanced"><summary>Advanced swap details</summary><label htmlFor="hook-data">Hook data (hex)</label><input id="hook-data" className="mono" type="text" value={hookData} autoComplete="off" spellCheck={false} aria-invalid={fieldError === 'hook-data'} aria-describedby={fieldError === 'hook-data' ? 'action-error' : 'hook-help'} onChange={e => { setHookData(e.target.value); invalidate(); }} /><p id="hook-help" className="fine-print">Forwarded unchanged. This hook ignores hook data; it is not authenticated.</p><dl className="detail-list"><div><dt>Route</dt><dd>PoolSwapTest</dd></div><div><dt>sqrtPriceLimitX96</dt><dd className="mono break">{quote ? String(quote.sqrtLimit) : 'Available after quote'}</dd></div></dl></details>
              <div className="slot-notice"><span aria-hidden="true">◷</span><p>{snapshot && !stale ? <><strong>{snapshot.remaining} {snapshot.remaining === 1 ? 'slot' : 'slots'} remaining</strong> in the latest block</> : 'Waiting for fresh slot availability'}</p></div>
              <button className={`${quote ? '' : 'primary'} full-width`} type="submit" disabled={!!busy || pending || (!!account && (!ready || snapshot?.remaining === 0))}>{busy === 'Getting quote…' ? busy : !account ? 'Connect wallet to quote' : quote ? 'Refresh quote' : 'Get quote'} <span aria-hidden="true">→</span></button>
            </fieldset>
          </form>
          {quote && <div className="quote-actions"><p className="fine-print">Quote at block {quote.block.toLocaleString('en-US')} · {quoteExpired ? 'Expired — get a new quote' : `expires in ${Math.max(0, Math.ceil((quote.at + 60000 - now) / 1000))}s`}.</p>
            {needsApproval && <><p className="fine-print">Approve exactly {units(quote.amount, inDecimals, 8)} RATE for PoolSwapTest. Approval does not use a swap slot.</p><button className="primary full-width" onClick={approve} disabled={!ready || !!busy || quoteExpired || pending}>1. Approve RATE</button></>}
            {!review && <button className={`${needsApproval ? '' : 'primary'} full-width`} onClick={simulate} disabled={!ready || !!busy || quoteExpired || needsApproval || pending}>{buy ? 'Simulate swap' : '2. Simulate swap'}</button>}
            {review && <div className="review"><h3>Review your swap</h3><dl className="detail-list"><div><dt>Simulated spend</dt><dd>{units(review.amounts.input, inDecimals, 8)} {inputSymbol}</dd></div><div><dt>Simulated receive</dt><dd>{units(review.amounts.output, outDecimals, 8)} {outputSymbol}</dd></div><div><dt>Slots at simulation</dt><dd>{review.slots.remaining} / 3</dd></div><div><dt>Network fee</dt><dd>Set by your wallet</dd></div></dl><p className="fine-print">{review.amounts.input < quote.amount ? 'Partial fill: unused input stays with you or is refunded. ' : ''}Final amounts may change. Slots are shared and cannot be reserved. The swap can revert if the block fills before inclusion.</p><button className="primary full-width" onClick={send} disabled={!ready || !!busy || quoteExpired || pending}>Confirm swap in wallet <Arrow /></button><button className="text-button" disabled={!!busy} onClick={() => setReview(undefined)}>Cancel review</button></div>}
          </div>}
          <p className="action-status" role="status">{busy || status}</p>
          <div id="action-error" className={error ? 'message error' : ''} role="alert">{error}</div>
          {transaction && <div className="transaction"><strong>{transaction.kind === 'swap' ? 'Swap' : 'Approval'} {transaction.state}</strong><a href={`${explorer}/tx/${transaction.hash}`} target="_blank" rel="noreferrer">View transaction {shorten(transaction.hash)} <Arrow /></a>{transaction.state === 'unknown' && <button disabled={!!busy} onClick={() => run('Checking transaction…', () => waitForReceipt(transaction))}>Check transaction</button>}</div>}
          <p className="swap-footnote">{buy ? 'ETH buys need no token approval. Leave ETH for gas.' : 'RATE sells require a separate token approval and ETH for gas.'} <a href={c.manifest.network.faucets[0]} target="_blank" rel="noreferrer">Get test ETH <Arrow /></a></p>
        </section>
      </div>
      <section id="how-it-works" className="explanation"><div><p className="eyebrow">A small rule, onchain</p><h2>A new block.<br />A fresh start.</h2></div><div className="explanation-copy"><p>Every accepted swap uses one of three slots in this pool. The fourth swap reverts. When a new block starts, all three slots are available again.</p><p>All traders, routers, directions and swap sizes share the same limit. Liquidity changes are not counted. There is no owner or admin.</p><aside><strong>A Sepolia demo</strong><p>Anyone can fill the slots with dust swaps for the cost of gas. This is a demo of per-block rate limiting, not spam or MEV protection.</p></aside></div></section>
      <details className="deployment-details"><summary>Deployment &amp; contract addresses <span className="summary-caption">Verified ABIs · {c.chain.name}</span></summary><p className="fine-print">Chain and deployed code {service.verified ? 'checked via public RPC' : 'awaiting verification'}. ABI hashes checked against the deployment manifest. RATE supply: {snapshot ? units(snapshot.supply, snapshot.decimals, 0) : 'awaiting chain'}.</p><div className="contract-grid">{contractLinks.map(contract => <div key={contract.name}><span>{contract.name}</span><a className="mono break" href={`${explorer}/address/${contract.address}`} target="_blank" rel="noreferrer">{contract.address} <Arrow /></a></div>)}</div><dl className="detail-list"><div><dt>Pool ID</dt><dd className="mono break">{c.poolId}</dd></div><div><dt>Connected account</dt><dd className="mono break">{account || 'Disconnected'}</dd></div><div><dt>Source commit</dt><dd className="mono break">{c.manifest.sourceCommit}</dd></div><div><dt>Attestation</dt><dd className="mono break">{c.manifest.attestationHash}</dd></div></dl><a href="./imd-deployment.json" target="_blank" rel="noreferrer">Open deployment manifest <Arrow /></a></details>
    </main>
    <footer className="shell site-footer"><span>ratelimit / an onchain experiment</span><span>Sepolia · Uniswap v4 · No backend</span></footer>
  </>;
}
