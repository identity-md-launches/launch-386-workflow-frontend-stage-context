# Ratelimit (RATE) + SwapRateLimitHook

Contracts for the `lab-rate-limit-hook` launch on Sepolia: a fixed-supply ERC-20 and a Uniswap v4
hook that allows at most **3 swaps per pool per block**.

> This is a Sepolia demonstration of per-block rate limiting. It is **not** spam protection and
> **not** MEV protection. Anyone can fill the 3 slots of a block with dust swaps for the cost of gas,
> and doing so blocks every other swap on that pool until the next block.

## Contracts

| Contract            | File                        | Purpose                                                            |
| ------------------- | --------------------------- | ------------------------------------------------------------------ |
| `Ratelimit`         | `src/Ratelimit.sol`         | ERC-20 "Ratelimit" / `RATE`, 18 decimals, 1,000,000,000 fixed supply |
| `SwapRateLimitHook` | `src/SwapRateLimitHook.sol` | v4 hook, `beforeSwap` only, 3 swaps per pool per block             |
| `HookFlags`         | `src/HookFlags.sol`         | Standalone copy of the v4 hook-address permission bits for tooling |

ABI exports: `docs/abi/Ratelimit.json`, `docs/abi/SwapRateLimitHook.json`
(generated with `forge inspect <Contract> abi --json`).

### Ratelimit (RATE)

- OpenZeppelin `ERC20`, nothing else. No constructor arguments.
- The constructor mints the whole supply (`TOTAL_SUPPLY = 1_000_000_000 ether`) to `msg.sender`,
  which at launch is the factory.
- No mint function, no owner, no pause, no proxy, no `delegatecall`, no `selfdestruct`, no
  transfer hook, no fee on transfer. The supply can never grow.

### SwapRateLimitHook

- Extends v4-periphery `BaseHook` (see [Dependencies](#dependencies) for the pin).
- Constructor: `(IPoolManager poolManager)`, exactly one argument. On Sepolia this is
  `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`.
- `getHookPermissions()` enables **exactly** `beforeSwap`. No other callback, no return deltas, no
  fee override. The hook address must therefore carry exactly flag bit 7 (`0x0080`) in its low 14
  bits; the constructor reverts otherwise (`Hooks.HookAddressNotValid`).
- No owner, no admin, no configuration, no funds. It never holds tokens and never touches deltas.
- State is keyed by `PoolId`: `mapping(PoolId => Window{uint64 blockNumber, uint8 count})`. Any
  pool on the same PoolManager may attach the hook; each pool is limited independently.
- Rule, enforced in `_beforeSwap`: read the pool's window; if the stored block is not
  `block.number` the count is 0; if the count is already `MAX_SWAPS_PER_BLOCK` (3), revert
  `RateLimited(block.number)`; otherwise increment, store, and emit
  `SwapCounted(poolId, block.number, count)`.
- Router, sender, direction, exact-in or exact-out, size and `hookData` are all ignored. A
  transaction that batches four swaps on one pool reverts as a whole, because the fourth
  `beforeSwap` reverts inside the same `unlock`.
- Liquidity changes and donations never reach the hook (no permission) and are never counted.
- View: `swapsInBlock(PoolId) -> (uint256 currentBlock, uint8 used, uint8 remaining)` with
  `currentBlock = block.number`, `used` = stored count if the stored block is the current one,
  else 0, and `remaining = 3 - used`.
- A swap refused by the limit reverts and emits nothing. The revert surfaces from the PoolManager
  as an ERC-7751 `WrappedError(hook, IHooks.beforeSwap.selector, RateLimited(blockNumber), HookCallFailed())`.

Reading the count from a frontend: call `swapsInBlock(poolId)` at the latest block, and index
`SwapCounted` events for per-block history. A block whose last `SwapCounted` has `count == 3`
hit the limit.

## Assumptions

- The launch pool is native ETH / RATE: `currency0 = address(0)`, `currency1 = RATE`,
  `fee = 3000`, `tickSpacing = 60`, `hooks = SwapRateLimitHook`. The fee is static; the hook
  returns a fee override of 0, which the PoolManager ignores for static-fee pools.
- The factory seeds one-sided RATE liquidity **below** the opening price. In v4 terms a range
  entirely below the current tick holds only `currency1` (RATE), so the seed needs no ETH and the
  first buy (`zeroForOne = true`, `amountSpecified < 0`) lands in a pool holding no ETH. The
  rehearsal in `test/LaunchRehearsal.t.sol` opens at tick 138,120 (about 1,000,000 RATE per ETH)
  with liquidity 5e23 over 60,000 ticks below it (about 474,000,000 RATE); the real opening price
  and seed size are the factory's parameters, not the hook's, and the hook does not depend on them.
- The hook has no initialise or liquidity permission, so it cannot revert the factory's pool
  initialisation or its seed.
- `hookData` is unauthenticated and is ignored by this hook; no swapper identity is read, so a
  router can neither claim nor be credited anything.
- The v4 `sender` passed to `beforeSwap` is the router, not the end user. The hook does not use it.
- Block numbers fit in `uint64` (they will for the foreseeable future on every EVM chain).

## Deployment parameters

| Parameter                         | Value                                                              |
| --------------------------------- | ------------------------------------------------------------------ |
| Chain                             | Sepolia, chain id 11155111                                         |
| PoolManager                       | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`                       |
| Hook constructor args             | `(IPoolManager) = (0xE03A1074c86CFeDd5C142C4F04F1a1536e203543)`    |
| Hook permission flags             | `beforeSwap` only, mask `0x0080` (bit 7), `HookFlags.BEFORE_SWAP`  |
| Hook deployment                   | CREATE2 with a salt mined so the address's low 14 bits equal `0x0080` (`HookMiner.find`) |
| Token constructor args            | none                                                               |
| Token name / symbol / decimals    | `Ratelimit` / `RATE` / 18                                          |
| Token supply                      | 1,000,000,000 RATE, minted once to the deployer (the factory)      |
| Pool key                          | currency0 native ETH, currency1 RATE, fee 3000, tickSpacing 60, hooks = SwapRateLimitHook |
| Compiler                          | solc 0.8.26, evm `cancun`, optimizer on, 44,444,444 runs, `via_ir = true`, `bytecode_hash = "none"` |
| Live Sepolia helpers (frontend)   | PoolSwapTest `0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe`, StateView `0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C`, V4Quoter `0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227` |

`script/DeploySwapRateLimitHook.s.sol` is a reviewable rehearsal of what the factory does: it
mines the salt and deploys the hook and the token. All its configuration is constants; `run()`
reads no environment variable. Tests call `mineSalt` and `deploy` directly against a local
PoolManager. This assignment authorises no transactions: publication, attestation, admission,
deployment through the factory and the website are later service steps. The `launch.json`
manifest is produced by a separate assignment and must list the same permission set
(`beforeSwap` only), the same constructor argument, and decimals 18.

## Operational responsibilities

- **Nobody operates the contracts.** There is no owner, admin, pauser, upgrader or fee recipient
  on either contract. After deployment nothing can be changed; a different limit means a new hook
  at a new address and a new pool.
- **The factory** deploys the token (and so receives the supply), mines the hook salt, deploys the
  hook via CREATE2 at an address whose low 14 bits are `0x0080`, initialises the pool and seeds
  it one-sided in RATE. If the mined address does not carry exactly that bit, the hook constructor
  reverts and nothing is deployed.
- **Reviewers** check that `getHookPermissions()`, the deployed address bits and the manifest all
  say `beforeSwap` only, that the constructor argument is the Sepolia PoolManager, and that the
  runtime code contains no `DELEGATECALL`, `CALLCODE` or `SELFDESTRUCT` (both contracts are tested
  for this).
- **The frontend** shows `swapsInBlock` for the latest block, a per-block history of
  `SwapCounted` with blocks that reached `count == 3` flagged, and the remaining slots before a
  swap is sent. It must expect a swap sent into a full block to revert with the wrapped
  `RateLimited` error and emit nothing.
- **Users and LPs** should know: at most 3 swaps per block per pool, first come first served,
  griefable with dust for gas alone; liquidity can always be added or removed, and donations
  always go through, even in a full block.

## Security notes

- Every hook callback is guarded by `onlyPoolManager` from `ImmutableState`; direct calls revert
  with `NotPoolManager`. Callbacks the hook does not declare revert with `HookNotImplemented`
  even when the PoolManager is the caller, but the PoolManager never calls them because the
  address does not advertise them.
- No return-delta permissions: the hook cannot take, skim or redirect funds.
- No external calls, no oracles, no proxies, no `delegatecall`, no `selfdestruct`, no storage of
  anything but the counter.
- The `SwapCounted` event and the `swapsInBlock` view are informational; they cannot influence
  the limit.
- Passing tests are not an audit. The launch process includes an independent review before
  admission; this repository is the input to that review.

## Testing

```bash
forge build
forge test
forge fmt --check
```

Tests run against a real v4-core `PoolManager` with the v4-core test routers
(`PoolSwapTest`, `PoolModifyLiquidityTest`, `PoolDonateTest`). They read no environment
variables and pass in any order and in parallel.

| File                                   | Covers                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `test/Ratelimit.t.sol`                 | metadata, single mint to deployer, no mint/admin entry points, exact transfers, allowance, opcode scan |
| `test/SwapRateLimitHook.t.sol`         | permissions and address bits, caller checks, 3 pass / 4th reverts, next block resets, two pools independent, different routers and senders all count, size/direction/hookData ignored, batched four swaps revert as a whole, liquidity and donations uncounted and working in a full block, pool initialisation never refused, refused swap emits nothing, fuzz |
| `test/LaunchRehearsal.t.sol`           | native ETH / RATE pool, one-sided RATE seed below the opening price with no ETH, first buy into the ETH-less pool, sell back, rate limit on the launch pool, dust griefing, batched native swaps, LP exit in a full block |
| `test/DeployScript.t.sol`              | script constants, salt mining determinism, deploy places the hook on a matching address and mints to the deployer |

`test/mocks/MockERC20.sol` and `src/HookFlags.sol` are also used by the network's protected
admission tests, which run against the attested creation code.

## Dependencies

All dependencies are vendored as ordinary files under `lib/` (no submodules) so the project builds
offline. Pins and the list of kept files are in `lib/VENDORED.md`. v4-periphery is pinned to
`444c526`, the last commit that ships `src/utils/BaseHook.sol`; later commits moved `BaseHook` to
the separate `v4-hooks-public` repository unchanged.

## Layout

```
src/                    Ratelimit.sol, SwapRateLimitHook.sol, HookFlags.sol
test/                   Foundry tests, test/mocks, test/utils
script/                 DeploySwapRateLimitHook.s.sol (rehearsal; constants only)
docs/abi/               ABI exports
lib/                    vendored dependencies (see lib/VENDORED.md)
foundry.toml            solc 0.8.26, cancun, via_ir, bytecode_hash = "none", ffi off, no fs access
remappings.txt
```
