// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {SwapRateLimitHook} from "../src/SwapRateLimitHook.sol";
import {Ratelimit} from "../src/Ratelimit.sol";
import {HookFlags} from "../src/HookFlags.sol";

/// @notice Reviewable rehearsal of what the launch factory does: mine a CREATE2 salt for the hook,
/// deploy it against the Sepolia PoolManager, and deploy RATE.
/// @dev The launch itself is performed by the IdentityMD factory after review, not by this script:
/// this assignment authorises no transactions. All configuration is a constant; `run()` reads no
/// environment variable. Tests exercise `mineSalt` and `deploy` directly against a local manager.
contract DeploySwapRateLimitHook is Script {
    /// @notice Uniswap v4 PoolManager on Sepolia (chain id 11155111).
    IPoolManager public constant SEPOLIA_POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);

    /// @notice The canonical deterministic-deployment proxy used when broadcasting `new X{salt: s}()`.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice The only permission bit the hook address must carry.
    uint160 public constant HOOK_FLAGS = HookFlags.BEFORE_SWAP;

    function run() external returns (SwapRateLimitHook hook, Ratelimit token) {
        vm.startBroadcast();
        (hook, token) = deploy(SEPOLIA_POOL_MANAGER, CREATE2_DEPLOYER);
        vm.stopBroadcast();
    }

    /// @notice Finds the salt under which `deployer` places the hook on an address with exactly `HOOK_FLAGS`.
    function mineSalt(IPoolManager poolManager, address deployer)
        public
        view
        returns (address predicted, bytes32 salt)
    {
        return HookMiner.find(deployer, HOOK_FLAGS, type(SwapRateLimitHook).creationCode, abi.encode(poolManager));
    }

    /// @notice Deploys the hook at its mined address and the token; both without any owner.
    function deploy(IPoolManager poolManager, address deployer)
        public
        returns (SwapRateLimitHook hook, Ratelimit token)
    {
        (address predicted, bytes32 salt) = mineSalt(poolManager, deployer);
        hook = new SwapRateLimitHook{salt: salt}(poolManager);
        require(address(hook) == predicted, "hook address mismatch");
        token = new Ratelimit();
    }
}
