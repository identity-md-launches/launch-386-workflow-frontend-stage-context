// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ImmutableState} from "v4-periphery/src/base/ImmutableState.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookTestBase, BatchSwapper} from "./utils/HookTestBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {SwapRateLimitHook} from "../src/SwapRateLimitHook.sol";
import {HookFlags} from "../src/HookFlags.sol";

/// @notice Behaviour of SwapRateLimitHook against a real v4-core PoolManager on ERC-20/ERC-20 pools.
contract SwapRateLimitHookTest is HookTestBase {
    MockERC20 internal token0;
    MockERC20 internal token1;
    MockERC20 internal token2;

    PoolKey internal keyA;
    PoolKey internal keyB;
    PoolId internal idA;
    PoolId internal idB;

    address internal alice = makeAddr("alice");

    function setUp() public {
        _deployCore();

        MockERC20 a = new MockERC20("A", "A", 1e30);
        MockERC20 b = new MockERC20("B", "B", 1e30);
        MockERC20 c = new MockERC20("C", "C", 1e30);
        (a, b) = address(a) < address(b) ? (a, b) : (b, a);
        (b, c) = address(b) < address(c) ? (b, c) : (c, b);
        (a, b) = address(a) < address(b) ? (a, b) : (b, a);
        (token0, token1, token2) = (a, b, c);

        MockERC20[3] memory tokens = [token0, token1, token2];
        for (uint256 i = 0; i < tokens.length; i++) {
            tokens[i].approve(address(swapRouter), type(uint256).max);
            tokens[i].approve(address(liquidityRouter), type(uint256).max);
            tokens[i].approve(address(donateRouter), type(uint256).max);
        }

        keyA = _key(Currency.wrap(address(token0)), Currency.wrap(address(token1)));
        keyB = _key(Currency.wrap(address(token1)), Currency.wrap(address(token2)));
        idA = keyA.toId();
        idB = keyB.toId();

        manager.initialize(keyA, SQRT_PRICE_1_1);
        manager.initialize(keyB, SQRT_PRICE_1_1);
        _addLiquidity(keyA, 1e24);
        _addLiquidity(keyB, 1e24);
    }

    function _addLiquidity(PoolKey memory key, int256 liquidity) internal returns (BalanceDelta) {
        return _addLiquidity(key, liquidity, bytes32(0));
    }

    function _addLiquidity(PoolKey memory key, int256 liquidity, bytes32 salt) internal returns (BalanceDelta) {
        return liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, liquidity, salt), "");
    }

    // ---------------------------------------------------------------- shape

    function test_permissionsAreExactlyBeforeSwap() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeSwap);
        assertFalse(p.beforeInitialize);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.afterSwap);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta);
        assertFalse(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
    }

    function test_addressCarriesExactlyBeforeSwap() public view {
        assertEq(HookFlags.flagsOf(address(hook)), HookFlags.BEFORE_SWAP);
        assertTrue(HookFlags.matches(address(hook), HookFlags.BEFORE_SWAP));
        assertEq(uint160(Hooks.BEFORE_SWAP_FLAG), HookFlags.BEFORE_SWAP, "HookFlags disagrees with v4-core");
        assertEq(uint160(Hooks.ALL_HOOK_MASK), HookFlags.ALL);
    }

    function test_constructorRefusesAnAddressWithoutTheFlag() public {
        // Plain CREATE gives an address with random low bits; the odds that they equal exactly the
        // beforeSwap bit are 1 in 16384, so this is deterministic for all practical purposes.
        vm.expectRevert();
        new SwapRateLimitHook(manager);
    }

    function test_constantsAndImmutables() public view {
        assertEq(hook.MAX_SWAPS_PER_BLOCK(), 3);
        assertEq(address(hook.poolManager()), address(manager));
    }

    function test_beforeSwapRefusesCallersOtherThanThePoolManager() public {
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.beforeSwap(address(this), keyA, _swapParams(true, 1e18), "");

        vm.prank(alice);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.beforeSwap(alice, keyA, _swapParams(true, 1e18), "");

        assertEq(_used(idA), 0, "a refused direct call must not count");
    }

    function test_unimplementedCallbacksRevertEvenForThePoolManager() public {
        vm.startPrank(address(manager));
        vm.expectRevert();
        hook.afterSwap(address(this), keyA, _swapParams(true, 1e18), BalanceDelta.wrap(0), "");
        vm.expectRevert();
        hook.beforeAddLiquidity(address(this), keyA, ModifyLiquidityParams(-60, 60, 1, bytes32(0)), "");
        vm.stopPrank();
    }

    function test_runtimeCodeHasNoEscapeHatch() public view {
        bytes memory code = address(hook).code;
        assertGt(code.length, 0);
        assertLe(code.length, 24_576);
        for (uint256 i = 0; i < code.length; i++) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x60 + 1;
                continue;
            }
            assertTrue(op != 0xff && op != 0xf4 && op != 0xf2, "forbidden opcode");
        }
    }

    // ---------------------------------------------------------------- the rule

    function test_threeSwapsPassAndTheFourthReverts() public {
        for (uint8 i = 1; i <= 3; i++) {
            vm.expectEmit(true, true, true, true, address(hook));
            emit SwapRateLimitHook.SwapCounted(idA, block.number, i);
            _swap(swapRouter, keyA, i % 2 == 0, 1e18, 0);
            assertEq(_used(idA), i);
            assertEq(_remaining(idA), 3 - i);
        }

        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);

        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, false, 1, 0);

        assertEq(_used(idA), 3);
        assertEq(_remaining(idA), 0);
    }

    function test_refusedSwapEmitsNothingAndChangesNothing() public {
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, true, 1e18, 0);
        }
        uint160 priceBefore = _sqrtPrice(idA);
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));

        vm.recordLogs();
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 0, "a refused swap emitted something");
        uint160 priceAfter = _sqrtPrice(idA);
        assertEq(priceAfter, priceBefore, "price moved");
        assertEq(token0.balanceOf(address(this)), bal0);
        assertEq(token1.balanceOf(address(this)), bal1);
        assertEq(_used(idA), 3);
    }

    function test_nextBlockResetsTheCount() public {
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, true, 1e18, 0);
        }
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);

        vm.roll(block.number + 1);
        (uint256 currentBlock, uint8 used, uint8 remaining) = hook.swapsInBlock(idA);
        assertEq(currentBlock, block.number);
        assertEq(used, 0, "stale window must read as zero");
        assertEq(remaining, 3);

        vm.expectEmit(true, true, true, true, address(hook));
        emit SwapRateLimitHook.SwapCounted(idA, block.number, 1);
        _swap(swapRouter, keyA, true, 1e18, 0);
        assertEq(_used(idA), 1);

        // Skipping many blocks behaves the same as skipping one.
        vm.roll(block.number + 1_000);
        assertEq(_used(idA), 0);
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, false, 1e18, 0);
        }
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, false, 1e18, 0);
    }

    function test_twoPoolsAreIndependent() public {
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, true, 1e18, 0);
        }
        assertEq(_remaining(idA), 0);
        assertEq(_remaining(idB), 3, "pool B must be untouched by pool A's swaps");

        for (uint8 i = 1; i <= 3; i++) {
            vm.expectEmit(true, true, true, true, address(hook));
            emit SwapRateLimitHook.SwapCounted(idB, block.number, i);
            _swap(swapRouter, keyB, true, 1e18, 0);
        }
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyB, true, 1e18, 0);
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);
    }

    function test_swapsThroughDifferentRoutersAllCount() public {
        PoolSwapTest routerB = new PoolSwapTest(manager);
        PoolSwapTest routerC = new PoolSwapTest(manager);
        token0.approve(address(routerB), type(uint256).max);
        token1.approve(address(routerB), type(uint256).max);
        token0.approve(address(routerC), type(uint256).max);
        token1.approve(address(routerC), type(uint256).max);

        _swap(swapRouter, keyA, true, 1e18, 0);
        _swap(routerB, keyA, true, 1e18, 0);
        _swap(routerC, keyA, true, 1e18, 0);
        assertEq(_used(idA), 3);

        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(routerB, keyA, true, 1e18, 0);
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, false, 1e18, 0);
    }

    function test_swapsFromDifferentSendersAllCount() public {
        address bob = makeAddr("bob");
        token0.transfer(alice, 10e18);
        token0.transfer(bob, 10e18);
        vm.prank(alice);
        token0.approve(address(swapRouter), type(uint256).max);
        vm.prank(bob);
        token0.approve(address(swapRouter), type(uint256).max);

        _swap(swapRouter, keyA, true, 1e18, 0);
        vm.prank(alice);
        _swap(swapRouter, keyA, true, 1e18, 0);
        vm.prank(bob);
        _swap(swapRouter, keyA, true, 1e18, 0);

        vm.prank(alice);
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);
    }

    function test_sizeAndDirectionDoNotMatter() public {
        _swap(swapRouter, keyA, true, 1, 0); // dust buy
        _swap(swapRouter, keyA, false, 100e18, 0); // large sell
        // exact output
        swapRouter.swap(keyA, SwapParams(true, int256(1e18), _swapParams(true, 0).sqrtPriceLimitX96), _noClaims(), "");
        assertEq(_used(idA), 3);
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1, 0);
    }

    function test_hookDataIsIgnored() public {
        bytes memory junk = abi.encode(alice, uint256(42), "anything");
        for (uint8 i = 1; i <= 3; i++) {
            vm.expectEmit(true, true, true, true, address(hook));
            emit SwapRateLimitHook.SwapCounted(idA, block.number, i);
            swapRouter.swap(keyA, _swapParams(true, 1e18), _noClaims(), junk);
        }
        vm.expectRevert(_rateLimitedRevert(block.number));
        swapRouter.swap(keyA, _swapParams(true, 1e18), _noClaims(), junk);
    }

    function test_batchOfFourSwapsRevertsAsAWhole() public {
        BatchSwapper batch = new BatchSwapper(swapRouter);
        token0.transfer(address(batch), 100e18);
        vm.prank(address(batch));
        token0.approve(address(swapRouter), type(uint256).max);

        uint256 balBefore = token0.balanceOf(address(batch));
        uint160 priceBefore = _sqrtPrice(idA);

        vm.expectRevert(_rateLimitedRevert(block.number));
        batch.swapMany(keyA, _swapParams(true, 1e18), 4);

        assertEq(_used(idA), 0, "the three inner swaps must be rolled back with the fourth");
        assertEq(token0.balanceOf(address(batch)), balBefore, "no tokens moved");
        uint160 priceAfter = _sqrtPrice(idA);
        assertEq(priceAfter, priceBefore, "price moved");

        // A batch of exactly three in a fresh block is fine.
        batch.swapMany(keyA, _swapParams(true, 1e18), 3);
        assertEq(_used(idA), 3);
    }

    function test_liquidityAndDonationsAreNotCountedAndStillWorkInAFullBlock() public {
        _addLiquidity(keyA, 10e18);
        donateRouter.donate(keyA, 1e18, 1e18, "");
        assertEq(_used(idA), 0, "liquidity and donations must not count");

        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, true, 1e18, 0);
        }
        assertEq(_remaining(idA), 0);

        // The pool is full for swaps; LPs and donors are unaffected. A fresh position (salt 1) so the
        // v4-core test router's "an add never collects fees" assertion holds.
        bytes32 fresh = bytes32(uint256(1));
        BalanceDelta added = _addLiquidity(keyA, 10e18, fresh);
        assertLt(added.amount0(), 0);
        assertLt(added.amount1(), 0);
        BalanceDelta removed = _addLiquidity(keyA, -10e18, fresh);
        assertGt(removed.amount0(), 0);
        assertGt(removed.amount1(), 0);
        BalanceDelta seedOut = _addLiquidity(keyA, -1e24);
        assertGt(seedOut.amount0(), 0, "the original LP can leave a full block too");
        donateRouter.donate(keyA, 1e18, 0, "");
        assertEq(_used(idA), 3, "still exactly three");

        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, keyA, true, 1e18, 0);
    }

    function test_poolInitialisationIsNeverRefused() public {
        // The hook has no initialise permission, so opening a new pool cannot touch it: the factory's
        // pool creation and one-sided seed cannot be reverted by the hook.
        MockERC20 fresh = new MockERC20("D", "D", 1e30);
        fresh.approve(address(liquidityRouter), type(uint256).max);
        (Currency c0, Currency c1) = address(fresh) < address(token0)
            ? (Currency.wrap(address(fresh)), Currency.wrap(address(token0)))
            : (Currency.wrap(address(token0)), Currency.wrap(address(fresh)));
        PoolKey memory key = _key(c0, c1);
        manager.initialize(key, SQRT_PRICE_1_1);
        _addLiquidity(key, 1e18);
        (uint256 currentBlock, uint8 used, uint8 remaining) = hook.swapsInBlock(key.toId());
        assertEq(currentBlock, block.number);
        assertEq(used, 0);
        assertEq(remaining, 3);
    }

    function test_swapsInBlockOnAnUnknownPool() public view {
        PoolId unknown = PoolId.wrap(keccak256("never initialised"));
        (uint256 currentBlock, uint8 used, uint8 remaining) = hook.swapsInBlock(unknown);
        assertEq(currentBlock, block.number);
        assertEq(used, 0);
        assertEq(remaining, 3);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_upToThreeSwapsOfAnySizePass(uint8 n, uint96 amount, bool zeroForOne) public {
        n = uint8(bound(n, 0, 3));
        amount = uint96(bound(amount, 1, 100e18));
        for (uint8 i = 0; i < n; i++) {
            _swap(swapRouter, keyA, zeroForOne, amount, 0);
        }
        assertEq(_used(idA), n);
        assertEq(_remaining(idA), 3 - n);
        if (n == 3) {
            vm.expectRevert(_rateLimitedRevert(block.number));
            _swap(swapRouter, keyA, zeroForOne, amount, 0);
        }
    }

    function testFuzz_countResetsAtAnyLaterBlock(uint64 skip) public {
        skip = uint64(bound(skip, 1, type(uint64).max - block.number - 1));
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, keyA, true, 1e18, 0);
        }
        vm.roll(block.number + skip);
        assertEq(_used(idA), 0);
        _swap(swapRouter, keyA, true, 1e18, 0);
        assertEq(_used(idA), 1);
    }

    function testFuzz_directCallFromAnyoneButTheManagerIsRefused(address caller) public {
        vm.assume(caller != address(manager));
        vm.prank(caller);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.beforeSwap(caller, keyA, _swapParams(true, 1e18), "");
    }
}
