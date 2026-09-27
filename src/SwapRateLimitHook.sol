// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

/// @title SwapRateLimitHook
/// @notice A Uniswap v4 hook that allows at most `MAX_SWAPS_PER_BLOCK` swaps per pool per block.
/// @dev Enables exactly one permission, `beforeSwap`. It returns no deltas and no fee override, holds
/// no funds, has no owner and reads nothing from `hookData`. State is keyed by `PoolId`, so any pool
/// may attach it and every pool is limited independently.
///
/// The counter is a (block number, count) pair per pool. On every swap the hook reads the pair,
/// treats a stale block number as a count of zero, refuses the swap once the count has reached the
/// limit, and otherwise increments and stores it. Because the hook reverts, a transaction that
/// batches more swaps than the block has left reverts as a whole. Liquidity changes and donations
/// never reach the hook and are never counted.
///
/// This is a per-block rate limit and nothing more: anyone can fill a block's slots with dust swaps
/// for the cost of gas. It is not spam protection and not MEV protection.
contract SwapRateLimitHook is BaseHook {
    /// @notice Maximum number of swaps a pool accepts in one block.
    uint8 public constant MAX_SWAPS_PER_BLOCK = 3;

    /// @notice Per-pool counter. `blockNumber` is the block the count belongs to.
    struct Window {
        uint64 blockNumber;
        uint8 count;
    }

    /// @notice A swap was counted. `count` is the number of swaps in `blockNumber` including this one.
    event SwapCounted(PoolId indexed poolId, uint256 blockNumber, uint8 count);

    /// @notice The pool has already used all of its swaps in `blockNumber`.
    error RateLimited(uint256 blockNumber);

    mapping(PoolId poolId => Window) internal _windows;

    /// @param poolManager The Uniswap v4 PoolManager this hook serves.
    constructor(IPoolManager poolManager) BaseHook(poolManager) {}

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Swap budget of `poolId` in the current block.
    /// @return currentBlock `block.number`.
    /// @return used Swaps already counted in `currentBlock` (zero if the stored window is older).
    /// @return remaining `MAX_SWAPS_PER_BLOCK - used`.
    function swapsInBlock(PoolId poolId) external view returns (uint256 currentBlock, uint8 used, uint8 remaining) {
        currentBlock = block.number;
        Window memory window = _windows[poolId];
        used = window.blockNumber == currentBlock ? window.count : 0;
        remaining = MAX_SWAPS_PER_BLOCK - used;
    }

    /// @dev Called by the PoolManager (enforced by `BaseHook.beforeSwap`) before every swap. The
    /// router, the sender, the direction, the size and the hookData are all ignored on purpose:
    /// the rule is per pool per block, whoever asks.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        Window storage window = _windows[poolId];

        uint256 current = block.number;
        uint8 count = window.blockNumber == current ? window.count : 0;
        if (count >= MAX_SWAPS_PER_BLOCK) revert RateLimited(current);

        unchecked {
            count += 1;
        }
        // A block number does not fit in 64 bits for another ~10^12 years at 12 s per block.
        // forge-lint: disable-next-line(unsafe-typecast)
        window.blockNumber = uint64(current);
        window.count = count;

        emit SwapCounted(poolId, current, count);
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
