// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ratelimit} from "../src/Ratelimit.sol";
import {SwapRateLimitHook} from "../src/SwapRateLimitHook.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {ImmutableState} from "v4-periphery/src/base/ImmutableState.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {GasMeter} from "./utils/GasMeter.sol";
import {GasHookBase} from "./utils/GasHookBase.sol";

contract GasRatelimitFunctionsTest is GasMeter {
    Ratelimit internal rate;
    address internal constant RECIPIENT = address(0xCAFE);
    address internal constant HOLDER = address(0xBEEF);

    function setUp() public {
        rate = new Ratelimit();
        rate.transfer(HOLDER, 10 ether);
        vm.prank(HOLDER);
        rate.approve(address(this), 5 ether);
    }

    function test_gas_TOTAL_SUPPLY() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeWithSignature("TOTAL_SUPPLY()")), (uint256)), 1e27);
    }

    function test_gas_totalSupply() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeCall(ERC20.totalSupply, ())), (uint256)), 1e27);
    }

    function test_gas_name() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeCall(ERC20.name, ())), (string)), "Ratelimit");
    }

    function test_gas_symbol() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeCall(ERC20.symbol, ())), (string)), "RATE");
    }

    function test_gas_decimals() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeCall(ERC20.decimals, ())), (uint8)), 18);
    }

    function test_gas_balanceOf() public {
        assertEq(abi.decode(_success(address(rate), abi.encodeCall(ERC20.balanceOf, (HOLDER))), (uint256)), 10 ether);
    }

    function test_gas_allowance() public {
        assertEq(
            abi.decode(_success(address(rate), abi.encodeCall(ERC20.allowance, (HOLDER, address(this)))), (uint256)),
            5 ether
        );
    }

    function test_gas_approve() public {
        assertTrue(abi.decode(_success(address(rate), abi.encodeCall(ERC20.approve, (RECIPIENT, 1 ether))), (bool)));
        assertEq(rate.allowance(address(this), RECIPIENT), 1 ether);
    }

    function test_gas_transfer() public {
        assertTrue(abi.decode(_success(address(rate), abi.encodeCall(ERC20.transfer, (RECIPIENT, 1 ether))), (bool)));
        assertEq(rate.balanceOf(RECIPIENT), 1 ether);
        assertEq(rate.balanceOf(address(this)), 1e27 - 11 ether);
    }

    function test_gas_transferFrom() public {
        assertTrue(
            abi.decode(
                _success(address(rate), abi.encodeCall(ERC20.transferFrom, (HOLDER, RECIPIENT, 1 ether))), (bool)
            )
        );
        assertEq(rate.balanceOf(HOLDER), 9 ether);
        assertEq(rate.balanceOf(RECIPIENT), 1 ether);
        assertEq(rate.allowance(HOLDER, address(this)), 4 ether);
    }
}

contract GasHookFunctionsTest is GasHookBase {
    PoolKey internal unused;
    PoolKey internal active;
    PoolKey internal full;
    PoolKey internal stale;

    function setUp() public {
        _deployCore();
        unused = _key(Currency.wrap(address(0)), Currency.wrap(address(1)));
        active = _key(Currency.wrap(address(0)), Currency.wrap(address(2)));
        full = _key(Currency.wrap(address(0)), Currency.wrap(address(3)));
        stale = _key(Currency.wrap(address(0)), Currency.wrap(address(4)));
        vm.roll(100);
        _prime(stale, 3);
        vm.roll(101);
        _prime(active, 2);
        _prime(full, 3);
    }

    function _prime(PoolKey memory key, uint8 count) internal {
        for (uint8 i; i < count; ++i) {
            vm.prank(address(manager));
            hook.beforeSwap(address(this), key, _swapParams(true, 1), "");
        }
    }

    function _beforeSwap(PoolKey memory key, uint8 count) internal {
        bytes memory input = abi.encodeCall(IHooks.beforeSwap, (address(this), key, _swapParams(true, 1), bytes("")));
        vm.prank(address(manager));
        bytes memory output = _success(address(hook), input);
        (bytes4 selector, BeforeSwapDelta delta, uint24 fee) = abi.decode(output, (bytes4, BeforeSwapDelta, uint24));
        assertEq(selector, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(delta), 0);
        assertEq(fee, 0);
        assertEq(_used(key.toId()), count);
    }

    function _reverts(bytes memory input, bytes memory expected, bool asManager) internal {
        if (asManager) vm.prank(address(manager));
        (bool ok, bytes memory output) = _meter(address(hook), input, 0);
        assertFalse(ok, "call must revert");
        assertEq(output, expected);
    }

    function _disabled(bytes memory input) internal {
        _reverts(input, abi.encodeWithSelector(BaseHook.HookNotImplemented.selector), true);
    }

    function test_gas_beforeSwap_firstEver() public {
        _beforeSwap(unused, 1);
    }

    function test_gas_beforeSwap_firstInLaterBlock() public {
        _beforeSwap(stale, 1);
    }

    function test_gas_beforeSwap_third() public {
        _beforeSwap(active, 3);
    }

    function test_gas_beforeSwap_fourthReverts() public {
        _reverts(
            abi.encodeCall(IHooks.beforeSwap, (address(this), full, _swapParams(true, 1), bytes(""))),
            abi.encodeWithSelector(SwapRateLimitHook.RateLimited.selector, block.number),
            true
        );
        assertEq(_used(full.toId()), 3);
    }

    function test_gas_beforeSwap_unauthorizedReverts() public {
        _reverts(
            abi.encodeCall(IHooks.beforeSwap, (address(this), unused, _swapParams(true, 1), bytes(""))),
            abi.encodeWithSelector(ImmutableState.NotPoolManager.selector),
            false
        );
        assertEq(_used(unused.toId()), 0);
    }

    function test_gas_MAX_SWAPS_PER_BLOCK() public {
        assertEq(abi.decode(_success(address(hook), abi.encodeWithSignature("MAX_SWAPS_PER_BLOCK()")), (uint8)), 3);
    }

    function test_gas_poolManager() public {
        assertEq(
            abi.decode(_success(address(hook), abi.encodeWithSignature("poolManager()")), (address)), address(manager)
        );
    }

    function test_gas_getHookPermissions() public {
        Hooks.Permissions memory p =
            abi.decode(_success(address(hook), abi.encodeWithSignature("getHookPermissions()")), (Hooks.Permissions));
        Hooks.Permissions memory expected;
        expected.beforeSwap = true;
        assertEq(abi.encode(p), abi.encode(expected));
    }

    function _viewWindow(PoolId id, uint8 expectedUsed) internal {
        (uint256 current, uint8 used, uint8 remaining) = abi.decode(
            _success(address(hook), abi.encodeCall(SwapRateLimitHook.swapsInBlock, (id))), (uint256, uint8, uint8)
        );
        assertEq(current, block.number);
        assertEq(used, expectedUsed);
        assertEq(remaining, 3 - expectedUsed);
    }

    function test_gas_swapsInBlock_unused() public {
        _viewWindow(unused.toId(), 0);
    }

    function test_gas_swapsInBlock_active() public {
        _viewWindow(active.toId(), 2);
    }

    function test_gas_swapsInBlock_stale() public {
        _viewWindow(stale.toId(), 0);
    }

    function test_gas_beforeInitialize_reverts() public {
        _disabled(abi.encodeCall(IHooks.beforeInitialize, (address(this), unused, SQRT_PRICE_1_1)));
    }

    function test_gas_afterInitialize_reverts() public {
        _disabled(abi.encodeCall(IHooks.afterInitialize, (address(this), unused, SQRT_PRICE_1_1, int24(0))));
    }

    function test_gas_beforeAddLiquidity_reverts() public {
        _disabled(
            abi.encodeCall(
                IHooks.beforeAddLiquidity, (address(this), unused, ModifyLiquidityParams(-60, 60, 1, 0), bytes(""))
            )
        );
    }

    function test_gas_beforeRemoveLiquidity_reverts() public {
        _disabled(
            abi.encodeCall(
                IHooks.beforeRemoveLiquidity, (address(this), unused, ModifyLiquidityParams(-60, 60, -1, 0), bytes(""))
            )
        );
    }

    function test_gas_afterAddLiquidity_reverts() public {
        _disabled(
            abi.encodeCall(
                IHooks.afterAddLiquidity,
                (
                    address(this),
                    unused,
                    ModifyLiquidityParams(-60, 60, 1, 0),
                    BalanceDelta.wrap(0),
                    BalanceDelta.wrap(0),
                    bytes("")
                )
            )
        );
    }

    function test_gas_afterRemoveLiquidity_reverts() public {
        _disabled(
            abi.encodeCall(
                IHooks.afterRemoveLiquidity,
                (
                    address(this),
                    unused,
                    ModifyLiquidityParams(-60, 60, -1, 0),
                    BalanceDelta.wrap(0),
                    BalanceDelta.wrap(0),
                    bytes("")
                )
            )
        );
    }

    function test_gas_afterSwap_reverts() public {
        _disabled(
            abi.encodeCall(
                IHooks.afterSwap, (address(this), unused, _swapParams(true, 1), BalanceDelta.wrap(0), bytes(""))
            )
        );
    }

    function test_gas_beforeDonate_reverts() public {
        _disabled(abi.encodeCall(IHooks.beforeDonate, (address(this), unused, uint256(1), uint256(1), bytes(""))));
    }

    function test_gas_afterDonate_reverts() public {
        _disabled(abi.encodeCall(IHooks.afterDonate, (address(this), unused, uint256(1), uint256(1), bytes(""))));
    }
}
