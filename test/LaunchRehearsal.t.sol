// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {HookTestBase, BatchSwapper} from "./utils/HookTestBase.sol";
import {Ratelimit} from "../src/Ratelimit.sol";
import {SwapRateLimitHook} from "../src/SwapRateLimitHook.sol";

/// @notice Rehearsal of the Sepolia launch: the native-ETH / RATE pool the factory opens, seeded
/// one-sided with RATE below the opening price, a first buy into a pool holding no ETH, then a sell.
/// This contract plays the factory: it deploys RATE (so it holds the whole supply), the hook, the
/// pool and the seed.
contract LaunchRehearsalTest is HookTestBase {
    /// @dev Opening price: 1 ETH = ~1,000,000 RATE. tick 138,120 is a multiple of 60.
    int24 internal constant OPENING_TICK = 138_120;
    /// @dev The seed sits entirely below the opening price: [OPENING_TICK - 60000, OPENING_TICK), i.e.
    /// it sells RATE from the opening price down to ~1/400 of it. With this liquidity the seed is
    /// roughly 474,000,000 RATE and can absorb thousands of ETH before running out of range.
    int24 internal constant SEED_LOWER = OPENING_TICK - 60_000;
    int24 internal constant SEED_UPPER = OPENING_TICK;
    int256 internal constant SEED_LIQUIDITY = 5e23;

    Ratelimit internal rate;
    PoolKey internal key;
    PoolId internal id;

    address internal buyer = makeAddr("buyer");

    function setUp() public {
        _deployCore();
        rate = new Ratelimit();
        rate.approve(address(liquidityRouter), type(uint256).max);
        rate.approve(address(swapRouter), type(uint256).max);

        key = _key(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(rate)));
        id = key.toId();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(OPENING_TICK));
    }

    function _seed() internal returns (BalanceDelta delta) {
        delta =
            liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(SEED_LOWER, SEED_UPPER, SEED_LIQUIDITY, 0), "");
    }

    function test_poolKeyMatchesTheApprovedLaunch() public view {
        assertTrue(key.currency0.isAddressZero(), "currency0 must be native ETH");
        assertEq(Currency.unwrap(key.currency1), address(rate));
        assertEq(key.fee, 3000);
        assertEq(key.tickSpacing, 60);
        assertEq(address(key.hooks), address(hook));
        assertEq(rate.balanceOf(address(this)), rate.TOTAL_SUPPLY(), "the factory holds the whole supply");
    }

    function test_oneSidedSeedNeedsNoEthAndIsNotCounted() public {
        BalanceDelta delta = _seed();
        assertEq(delta.amount0(), 0, "a seed below the price must not require ETH");
        assertLt(delta.amount1(), 0, "the seed is paid in RATE");
        assertLt(uint256(-int256(delta.amount1())), rate.TOTAL_SUPPLY() / 2, "the seed fits in half the supply");
        assertEq(address(manager).balance, 0, "the pool holds no ETH");
        assertGt(rate.balanceOf(address(manager)), 0);
        assertEq(_used(id), 0, "seeding is not a swap");
    }

    function test_firstBuyIntoTheEthLessPoolThenASell() public {
        _seed();
        uint256 poolRate = rate.balanceOf(address(manager));
        vm.deal(buyer, 1 ether);

        // Buy: ETH in, RATE out (zeroForOne, exact input).
        vm.prank(buyer);
        BalanceDelta buy = _swap(swapRouter, key, true, 0.1 ether, 0.1 ether);
        assertEq(buy.amount0(), -int256(0.1 ether), "exact ETH input");
        assertGt(buy.amount1(), 0, "RATE received");
        assertEq(rate.balanceOf(buyer), uint256(int256(buy.amount1())));
        assertEq(address(manager).balance, 0.1 ether, "the pool now holds the ETH");
        assertEq(rate.balanceOf(address(manager)), poolRate - uint256(int256(buy.amount1())));
        assertEq(buyer.balance, 0.9 ether);
        assertEq(_used(id), 1);

        // Sell it all back: RATE in, ETH out (oneForZero, exact input).
        uint256 sellAmount = rate.balanceOf(buyer);
        vm.startPrank(buyer);
        rate.approve(address(swapRouter), sellAmount);
        BalanceDelta sell = _swap(swapRouter, key, false, sellAmount, 0);
        vm.stopPrank();
        assertEq(sell.amount1(), -int256(sellAmount), "exact RATE input");
        assertGt(sell.amount0(), 0, "ETH received");
        assertLt(uint256(int256(sell.amount0())), 0.1 ether, "fees keep the round trip from being free");
        assertEq(buyer.balance, 0.9 ether + uint256(int256(sell.amount0())));
        assertEq(_used(id), 2);
        assertEq(_remaining(id), 1);
    }

    function test_launchPoolIsRateLimitedLikeAnyOther() public {
        _seed();
        vm.deal(buyer, 10 ether);
        vm.startPrank(buyer);
        for (uint8 i = 1; i <= 3; i++) {
            vm.expectEmit(true, true, true, true, address(hook));
            emit SwapRateLimitHook.SwapCounted(id, block.number, i);
            _swap(swapRouter, key, true, 0.01 ether, 0.01 ether);
        }
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, key, true, 0.01 ether, 0.01 ether);
        vm.stopPrank();
        assertEq(buyer.balance, 10 ether - 0.03 ether, "the refused buy returned its ETH");

        vm.roll(block.number + 1);
        vm.prank(buyer);
        _swap(swapRouter, key, true, 0.01 ether, 0.01 ether);
        assertEq(_used(id), 1);
    }

    function test_dustSwapsFillTheBlockForAnyone() public {
        // Documented limitation: three 1-wei buys by anyone exhaust the block for everyone.
        _seed();
        address griefer = makeAddr("griefer");
        vm.deal(griefer, 1 ether);
        vm.deal(buyer, 1 ether);
        vm.startPrank(griefer);
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, key, true, 1, 1);
        }
        vm.stopPrank();

        vm.prank(buyer);
        vm.expectRevert(_rateLimitedRevert(block.number));
        _swap(swapRouter, key, true, 0.1 ether, 0.1 ether);
    }

    function test_batchedNativeSwapsRevertAsAWhole() public {
        _seed();
        BatchSwapper batch = new BatchSwapper(swapRouter);
        vm.deal(address(batch), 1 ether);
        vm.expectRevert(_rateLimitedRevert(block.number));
        batch.swapMany{value: 0.4 ether}(key, _swapParams(true, 0.1 ether), 4);
        assertEq(_used(id), 0);
        assertEq(address(manager).balance, 0, "no ETH reached the pool");
    }

    function test_liquidityCanBeRemovedInAFullBlock() public {
        _seed();
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        for (uint256 i = 0; i < 3; i++) {
            _swap(swapRouter, key, true, 0.01 ether, 0.01 ether);
        }
        vm.stopPrank();
        assertEq(_remaining(id), 0);

        BalanceDelta removed =
            liquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(SEED_LOWER, SEED_UPPER, -SEED_LIQUIDITY, 0), "");
        assertGt(removed.amount0(), 0, "the LP gets the ETH that was bought in");
        assertGt(removed.amount1(), 0, "and the unsold RATE");
    }
}
