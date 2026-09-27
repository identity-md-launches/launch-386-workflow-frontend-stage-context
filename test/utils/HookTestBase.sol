// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {SwapRateLimitHook} from "../../src/SwapRateLimitHook.sol";
import {HookFlags} from "../../src/HookFlags.sol";

/// @notice Shared scaffolding: a real v4-core PoolManager, the v4-core test routers and a
/// SwapRateLimitHook deployed with CREATE2 at an address carrying exactly the beforeSwap bit.
abstract contract HookTestBase is Test {
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint24 internal constant LP_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    PoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolDonateTest internal donateRouter;
    SwapRateLimitHook internal hook;

    function _deployCore() internal {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        donateRouter = new PoolDonateTest(manager);
        hook = deployHook(manager);
    }

    /// @dev Mines a salt so that CREATE2 from this contract lands the hook on an address whose low
    /// 14 bits are exactly BEFORE_SWAP, the way the launch deployer will.
    function deployHook(IPoolManager pm) internal returns (SwapRateLimitHook deployed) {
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), HookFlags.BEFORE_SWAP, type(SwapRateLimitHook).creationCode, abi.encode(pm));
        deployed = new SwapRateLimitHook{salt: salt}(pm);
        assertEq(address(deployed), predicted, "hook landed somewhere else");
    }

    function _key(Currency c0, Currency c1) internal view returns (PoolKey memory) {
        return
            PoolKey({
                currency0: c0, currency1: c1, fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))
            });
    }

    /// @dev Exact-input swap through `router`. `zeroForOne` buys currency1 with currency0.
    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 value)
        internal
        returns (BalanceDelta)
    {
        return router.swap{value: value}(key, _swapParams(zeroForOne, amountIn), _noClaims(), "");
    }

    function _noClaims() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _swapParams(bool zeroForOne, uint256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    /// @dev The revert the PoolManager surfaces when the hook refuses: an ERC-7751 wrapped error around
    /// `RateLimited(blockNumber)`.
    function _rateLimitedRevert(uint256 blockNumber) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(SwapRateLimitHook.RateLimited.selector, blockNumber),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _sqrtPrice(PoolId id) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
    }

    function _used(PoolId id) internal view returns (uint8 used) {
        (, used,) = hook.swapsInBlock(id);
    }

    function _remaining(PoolId id) internal view returns (uint8 remaining) {
        (,, remaining) = hook.swapsInBlock(id);
    }

    receive() external payable {}
}

/// @notice A caller that issues several swaps inside one call, standing in for a batching router or
/// a multicall. If any inner swap reverts the whole call reverts.
contract BatchSwapper {
    PoolSwapTest internal immutable router;

    constructor(PoolSwapTest router_) {
        router = router_;
    }

    function swapMany(PoolKey memory key, SwapParams memory params, uint256 times) external payable {
        uint256 each = msg.value / (times == 0 ? 1 : times);
        for (uint256 i = 0; i < times; i++) {
            router.swap{value: each}(key, params, PoolSwapTest.TestSettings(false, false), "");
        }
    }

    receive() external payable {}
}
