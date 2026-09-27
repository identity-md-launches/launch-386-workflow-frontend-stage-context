# Ratelimit frontend

A static, one-page observatory and swap form for the deployed ETH / RATE pool on Sepolia. Source is in `web/`; the publisher hosts the committed repository-root `dist/` without rebuilding. There is no backend, private RPC key, analytics service, external font, or WalletConnect project ID.

## Install, build and preview

Use Node 22.12+ (validated with Node 24.21.0) and npm.

```sh
cd web
npm ci
npm run build
npm run preview
```

Open the preview URL printed by Vite. For source development, first build the deployment files, then use `npm run dev`. The development middleware serves the same generated manifest and ABI files from `dist/`. This middleware is not included in the static export.

`npm run build` typechecks, exports Vite with `base: './'`, and **then** generates `dist/imd-deployment.json`. Always use this command instead of calling Vite alone. It verifies both implementation ABI hashes, copies their exact pinned bytes, exports protocol interfaces, inventories every exported file, and generates the final SHA-256 hashes. Do not edit `dist/` manually. `npm run verify` independently checks the manifest, inventory, ABI binding, relative paths, limits and network block.

## Configuration and provenance

- `config/handoff.json` and `config/network.json` preserve the supplied handoffs for reproducible builds after `.imd/reads/` is removed.
- `config/workflow.json` records the approved workflow's PoolSwapTest address. The deployment script copies it to the runtime manifest's `routing.poolSwapTest`. It is not an additional deployed launch contract.
- Runtime configuration comes exclusively from `dist/imd-deployment.json`, loaded by `src/config.ts`. Addresses and chain IDs are not compiled into a parallel runtime map. The `network` object is unchanged; `walletAddChain` is also preserved.
- The exact two-contract set, launch ID, chain ID, source commit and attestation hash come from the handoff. Implementation ABIs come from `git show <sourceCommit>:docs/abi/<Contract>.json`; canonical Keccak recursively sorts object keys, preserves array order, and hashes compact UTF-8 JSON. The runtime repeats the ABI hash check and checks each ABI's SHA-256 asset hash before reading contracts.
- `src/chain.ts` obtains PoolManager, StateView and V4Quoter addresses from the manifest's network block. The prescribed PoolSwapTest route takes precedence over the general Universal Router example. RATE approvals therefore target **PoolSwapTest directly**. Permit2 and Universal Router are listed for deployment transparency but never used for this route. Their addresses are never substituted for the workflow router.
- Protocol interface sources: repository `lib/v4-core/src/test/PoolSwapTest.sol`, official [IV4Quoter](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol) and [IStateView](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol). Minimal interfaces are emitted by `scripts/export.mjs`; they are distinct from the pinned implementation ABIs.
- The native ETH / RATE PoolId is derived from the handoff currencies, fee, tick spacing and deployed hook. StateView supplies the current price; the manifest's opening price is not presented as live data.

Changing a deployment requires an authorized replacement handoff, its source commit and matching implementation ABI exports. Rebuild and validate the whole export together. Serve `dist/` over HTTPS or localhost, with JSON and JavaScript MIME types; Web Crypto and browser wallets require a secure context. Any gateway subpath works without route rewrites.

## Reads, wallets and swaps

The page polls the configured public RPCs every 12 seconds, with sequential endpoint fallback. Counter, token metadata and pool price share a block number. The history queries the last 120 blocks in 30-block chunks, filters by the PoolId, groups accepted SwapCounted events by block, and flags counts of three. Missing RPC data is displayed as unavailable rather than zero. A failed history request has its own retry state. Recent head events can change under a chain reorganization; every refresh queries the entire window again.

Supported wallets expose `window.ethereum`. Connection is requested only after a button action. A missing network offers one switch control; a 4902/unknown-chain response triggers `wallet_addEthereumChain` with the supplied parameters, then switching again. Account changes, chain changes and disconnects invalidate quotes. WalletConnect and multi-provider selection are not configured; visitors with multiple extensions use their wallet's selected injected provider.

Before signing, the app verifies the RPC chain ID, nonempty code for required contracts, the hook and router's PoolManager bindings, and the onchain three-swap maximum. It also rechecks the selected wallet account and chain, latest slots, funds and allowance. Public RPCs provide reads; only the injected wallet signs. If public reads fail, signing stays disabled.

Buy and sell are exact-input requests: `amountSpecified` is negative; `zeroForOne` is true for native ETH in. V4Quoter is called using `simulateContract`, not sent as a transaction. Native buys send the input amount as ETH and approve nothing. RATE sells require a separate, exact-amount approval to PoolSwapTest. Approval does not consume a swap slot. Both operations wait for a receipt; a failed receipt is not reported as success, and unknown confirmation blocks another submission until checked.

PoolSwapTest forwards the configured `sqrtPriceLimitX96` and optional hook data, with `takeClaims=false` and `settleUsingBurn=false`. This hook ignores hook data; hook data is unauthenticated. The form derives its square-root price boundary using integer arithmetic from the quoted StateView spot price and a 0.01%–5% price movement tolerance. **This is a price limit, not an onchain minimum-output guarantee.** This router has neither a minimum-output parameter nor an onchain deadline. Partial fills can occur; unspent native input is refunded by the router, and unspent RATE remains in the wallet. The simulation review shows both actual simulated spend and receive. The app re-simulates before the wallet prompt. Quotes expire in the UI after 60 seconds, but a signed transaction can remain pending longer. Final amounts and availability can change.

The hook allows at most three swaps **per pool per block**, shared by all traders, routers, directions and sizes. The fourth swap reverts and emits no SwapCounted event. The next block resets the effective counter; liquidity changes and donations do not count. There is no admin or owner. Anyone can exhaust the three slots with dust swaps for the cost of gas. This is a **Sepolia rate-limit demo, not spam or MEV protection**. RATE has a fixed initial supply of one billion tokens and 18 decimals; the frontend reads current supply and decimals from the token.

## Validation

```sh
npm run typecheck
npm run build
npm run verify
npx playwright install chromium
npm test
npm run check:chain
npm audit
```

`npm test` owns a temporary HTTP server and Chromium for one bounded foreground run. It loads the actual production export under `/preview/`, tests mocked RPC/wallet interactions (never real broadcasts), then checks a real public-RPC browser read. It writes screenshots and results to `docs/evidence/`. `check:chain` records read-only live chain IDs, code, bindings, pool state and quoter simulations. Network checks can fail if the public RPCs are unavailable.

On this worker Playwright 1.56.1 does not recognize Ubuntu 26.04. Its Ubuntu 24.04 fallback Chromium was successfully installed and run using:

```sh
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/ratelimit-browsers npx playwright install chromium
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/ratelimit-browsers npm test
```

See [validation](../docs/VALIDATION.md), [design](../docs/DESIGN.md) and [evidence](../docs/evidence/interactions.json) for actual coverage and limitations. No live approval or swap was broadcast. Publication, IPFS pinning, names, wallet-extension integration and control-plane checks are outside this worker delivery.

## Scope and size

All delivered changes are inside `web/`, `dist/` and `docs/`. Only `web/.gitignore` is changed as an ignore file, using the assignment's explicit allowance; it excludes dependency/cache directories at any depth beneath `web/`. Dependencies are installed normally and are not committed. No vendored registry, dependency archive or submodule is added. Root Solidity/build configuration and deployed contract source are preserved.

The root `DESIGN.md` criterion conflicts with the higher-priority allowed-path rule. The complete document is therefore delivered at `docs/DESIGN.md`; no unauthorized root file is created. The approved workflow route is PoolSwapTest, so its address is preserved as a routing extension while the network block remains unchanged. Publication URLs and CIDs are not required or invented.
