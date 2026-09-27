// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Ratelimit} from "../src/Ratelimit.sol";
import {GasHookBase} from "./utils/GasHookBase.sol";

/// @dev Each concrete suite gets an independent manager and identical ETH/RATE seed. All prior
/// swaps happen in setUp, so the measured test starts with clean storage originals and cold
/// accesses. Merely pausing metering around prior swaps in a test would underprice a third swap.
abstract contract GasSwapFixture is GasHookBase {
    Ratelimit internal rate;
    PoolKey internal key;
    PoolId internal id;
    uint256 internal constant BUY = 0.01 ether;
    address internal constant BUYER = address(0xBEEF);
    uint256 internal rateBeforeBuy;

    function _prepare(bool withHook, uint8 scenario) internal {
        _deployCore();
        rate = new Ratelimit();
        rate.approve(address(liquidityRouter), type(uint256).max);
        key = _key(Currency.wrap(address(0)), Currency.wrap(address(rate)));
        if (!withHook) key.hooks = IHooks(address(0));
        id = key.toId();
        vm.roll(100);
        vm.deal(BUYER, 100 ether);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(138_120));
        BalanceDelta seeded =
            liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(78_120, 138_120, 5e23, bytes32(0)), "");
        assertEq(seeded.amount0(), 0, "seed must require only RATE");
        assertLt(seeded.amount1(), 0);
        assertEq(address(manager).balance, 0, "launch pool starts without ETH");

        // Scenario 0: first-ever buy. Scenario 1: first buy of a later block.
        // Scenario 2: third buy of that later block. Hook and control do identical swaps.
        if (scenario > 0) {
            for (uint256 i; i < 3; ++i) {
                _buy();
            }
            vm.roll(101);
        }
        if (scenario == 2) {
            _buy();
            _buy();
        }
        assertEq(_used(id), withHook && scenario == 2 ? 2 : 0);
        rateBeforeBuy = rate.balanceOf(BUYER);
    }

    function _buy() internal {
        vm.prank(BUYER);
        _swap(swapRouter, key, true, BUY, BUY);
    }

    function _measureBuy(bool withHook, uint8 expectedCount) internal {
        // Build inputs before starting the meter; do not pre-read target balances/counter slots.
        bytes memory input = abi.encodeCall(PoolSwapTest.swap, (key, _swapParams(true, BUY), _noClaims(), bytes("")));
        vm.prank(BUYER);
        (bool ok, bytes memory output) = _meter(address(swapRouter), input, BUY);
        assertTrue(ok, "buy reverted");
        BalanceDelta delta = abi.decode(output, (BalanceDelta));
        assertEq(delta.amount0(), -int256(BUY));
        assertGt(delta.amount1(), 0, "buy must receive RATE");
        assertEq(rate.balanceOf(BUYER), rateBeforeBuy + uint256(int256(delta.amount1())));
        assertEq(_used(id), withHook ? expectedCount : 0);
        assertEq(_remaining(id), withHook ? 3 - expectedCount : 3);
    }
}

contract GasSwapHookLaunchTest is GasSwapFixture {
    function setUp() public {
        _prepare(true, 0);
    }

    function test_gas_swap_hook_firstEver() public {
        _measureBuy(true, 1);
    }
}

contract GasSwapNoHookLaunchTest is GasSwapFixture {
    function setUp() public {
        _prepare(false, 0);
    }

    function test_gas_swap_noHook_firstEver() public {
        _measureBuy(false, 0);
    }
}

contract GasSwapHookFirstTest is GasSwapFixture {
    function setUp() public {
        _prepare(true, 1);
    }

    function test_gas_swap_hook_firstInLaterBlock() public {
        _measureBuy(true, 1);
    }
}

contract GasSwapNoHookFirstTest is GasSwapFixture {
    function setUp() public {
        _prepare(false, 1);
    }

    function test_gas_swap_noHook_firstInLaterBlock() public {
        _measureBuy(false, 0);
    }
}

contract GasSwapHookThirdTest is GasSwapFixture {
    function setUp() public {
        _prepare(true, 2);
    }

    function test_gas_swap_hook_thirdInLaterBlock() public {
        _measureBuy(true, 3);
    }
}

contract GasSwapNoHookThirdTest is GasSwapFixture {
    function setUp() public {
        _prepare(false, 2);
    }

    function test_gas_swap_noHook_thirdInLaterBlock() public {
        _measureBuy(false, 0);
    }
}
