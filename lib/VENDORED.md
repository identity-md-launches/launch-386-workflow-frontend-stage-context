# Vendored dependencies

Every dependency is committed as ordinary files (no git submodules) so the project builds offline.
Only the files the project imports are kept, plus each upstream licence.

| Directory                    | Upstream                                          | Commit                                     | Kept                                                                                  |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `lib/v4-core`                | https://github.com/Uniswap/v4-core                | `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` | `src/` (PoolManager, libraries, types, test routers), `test/utils/CurrencySettler.sol`, `licenses/` |
| `lib/v4-periphery`           | https://github.com/Uniswap/v4-periphery           | `444c526b77d804590f0d7bc5a481af5a3277c952` | `src/utils/BaseHook.sol`, `src/utils/HookMiner.sol`, `src/base/ImmutableState.sol`, `src/interfaces/IImmutableState.sol`, `LICENSE` |
| `lib/solmate`                | https://github.com/transmissions11/solmate        | `89365b880c4f3c786bdd453d4b8e8fe410344a69` | `src/auth/Owned.sol` (required by v4-core `ProtocolFees`), `LICENSE`                  |
| `lib/forge-std`              | https://github.com/foundry-rs/forge-std           | `3e2295d50379faa6c8e9859d51b1f97a69a830d1` | `src/`, licences                                                                      |
| `lib/openzeppelin-contracts` | https://github.com/OpenZeppelin/openzeppelin-contracts | `4858ab13a5ad897f59753028f6315f9d487c4322` | `contracts/token/ERC20/{ERC20,IERC20}.sol`, `extensions/IERC20Metadata.sol`, `utils/Context.sol`, `interfaces/IERC6093.sol`, `LICENSE` |

## Why v4-periphery is pinned to an older commit

v4-periphery removed `src/utils/BaseHook.sol` and `src/utils/HookMiner.sol` in commit `5da22e6`
("remove hooks and move to hook repo (#510)", 2026-02-06); they now live in
https://github.com/Uniswap/v4-hooks-public. The approved workflow requires the hook to extend the
v4-periphery `BaseHook`, so this project pins the parent commit `444c526`, the last one that ships
it. The file is byte-identical to `src/base/BaseHook.sol` in v4-hooks-public apart from the
`ImmutableState` import path.

The vendored v4-core is current `main`; its `IHooks` interface and hook flag layout are unchanged
from the version v4-periphery `444c526` was built against.
