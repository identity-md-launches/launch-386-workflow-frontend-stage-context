// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {DeploySwapRateLimitHook} from "../script/DeploySwapRateLimitHook.s.sol";
import {SwapRateLimitHook} from "../src/SwapRateLimitHook.sol";
import {Ratelimit} from "../src/Ratelimit.sol";
import {HookFlags} from "../src/HookFlags.sol";

contract DeployScriptTest is Test {
    DeploySwapRateLimitHook internal script;
    PoolManager internal manager;

    function setUp() public {
        script = new DeploySwapRateLimitHook();
        manager = new PoolManager(address(this));
    }

    function test_constantsMatchTheApprovedLaunch() public view {
        assertEq(address(script.SEPOLIA_POOL_MANAGER()), 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
        assertEq(script.HOOK_FLAGS(), HookFlags.BEFORE_SWAP);
    }

    function test_deployPlacesTheHookOnAMatchingAddressAndMintsToTheDeployer() public {
        // The script contract is the CREATE2 deployer in this rehearsal, so it mines for itself.
        (address predicted,) = script.mineSalt(manager, address(script));
        (SwapRateLimitHook hook, Ratelimit token) = script.deploy(manager, address(script));

        assertEq(address(hook), predicted);
        assertTrue(HookFlags.matches(address(hook), HookFlags.BEFORE_SWAP));
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(token.balanceOf(address(script)), token.TOTAL_SUPPLY(), "the deployer holds the supply");
    }

    function test_mineSaltIsDeterministicForAGivenManagerAndDeployer() public view {
        (address a, bytes32 sa) = script.mineSalt(manager, address(0xBEEF));
        (address b, bytes32 sb) = script.mineSalt(manager, address(0xBEEF));
        assertEq(a, b);
        assertEq(sa, sb);
        assertTrue(HookFlags.matches(a, HookFlags.BEFORE_SWAP));

        // A different manager changes the creation code, hence the salt and address.
        (address c,) = script.mineSalt(IPoolManager(address(0xCAFE)), address(0xBEEF));
        assertTrue(HookFlags.matches(c, HookFlags.BEFORE_SWAP));
        assertTrue(c != a);
    }
}
