// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {SwapRateLimitHook} from "../../src/SwapRateLimitHook.sol";
import {HookFlags} from "../../src/HookFlags.sol";
import {GasMeter} from "./GasMeter.sol";

abstract contract GasHookBase is GasMeter {
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    PoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    SwapRateLimitHook internal hook;

    function _deployCore() internal {
        // Use compiled artifacts to avoid embedding ~38 kB of infrastructure creation code in
        // every benchmark. These are real constructor deployments, not etched/mocked runtimes.
        manager = PoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        swapRouter = PoolSwapTest(payable(deployCode("PoolSwapTest.sol:PoolSwapTest", abi.encode(manager))));
        liquidityRouter = PoolModifyLiquidityTest(
            payable(deployCode("PoolModifyLiquidityTest.sol:PoolModifyLiquidityTest", abi.encode(manager)))
        );
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), HookFlags.BEFORE_SWAP, type(SwapRateLimitHook).creationCode, abi.encode(manager)
        );
        hook = new SwapRateLimitHook{salt: salt}(manager);
        assertEq(address(hook), predicted);
    }

    function _key(Currency c0, Currency c1) internal view returns (PoolKey memory) {
        return PoolKey(c0, c1, 3000, 60, IHooks(address(hook)));
    }

    function _swapParams(bool zeroForOne, uint256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams(
            zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
    }

    function _noClaims() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings(false, false);
    }

    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 value)
        internal
        returns (BalanceDelta)
    {
        return router.swap{value: value}(key, _swapParams(zeroForOne, amountIn), _noClaims(), "");
    }

    function _used(PoolId id) internal view returns (uint8 used) {
        (, used,) = hook.swapsInBlock(id);
    }

    function _remaining(PoolId id) internal view returns (uint8 remaining) {
        (,, remaining) = hook.swapsInBlock(id);
    }

    receive() external payable {}
}
