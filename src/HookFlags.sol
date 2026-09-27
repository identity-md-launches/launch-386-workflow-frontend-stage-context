// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookFlags
/// @notice The permission bits Uniswap v4 reads from the low 14 bits of a hook address.
/// @dev Mirrors `Hooks.sol` in v4-core bit for bit, but as a standalone library so that tooling
/// which mines or checks a hook address (the deployer, the admission checks, the manifest review)
/// does not have to pull in the full v4-core library graph.
library HookFlags {
    uint160 internal constant BEFORE_INITIALIZE = 1 << 13;
    uint160 internal constant AFTER_INITIALIZE = 1 << 12;
    uint160 internal constant BEFORE_ADD_LIQUIDITY = 1 << 11;
    uint160 internal constant AFTER_ADD_LIQUIDITY = 1 << 10;
    uint160 internal constant BEFORE_REMOVE_LIQUIDITY = 1 << 9;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY = 1 << 8;
    uint160 internal constant BEFORE_SWAP = 1 << 7;
    uint160 internal constant AFTER_SWAP = 1 << 6;
    uint160 internal constant BEFORE_DONATE = 1 << 5;
    uint160 internal constant AFTER_DONATE = 1 << 4;
    uint160 internal constant BEFORE_SWAP_RETURN_DELTA = 1 << 3;
    uint160 internal constant AFTER_SWAP_RETURN_DELTA = 1 << 2;
    uint160 internal constant AFTER_ADD_LIQUIDITY_RETURN_DELTA = 1 << 1;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_RETURN_DELTA = 1 << 0;

    /// @notice Mask of every permission bit.
    uint160 internal constant ALL = (1 << 14) - 1;

    /// @notice The permission bits carried by `hook`.
    function flagsOf(address hook) internal pure returns (uint160) {
        return uint160(hook) & ALL;
    }

    /// @notice True when the low 14 bits of `hook` are exactly `flags` (bits outside the mask ignored).
    function matches(address hook, uint160 flags) internal pure returns (bool) {
        return flagsOf(hook) == (flags & ALL);
    }
}
