// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Ratelimit (RATE)
/// @notice Fixed-supply ERC-20 for the SwapRateLimitHook launch on Sepolia.
/// @dev The whole supply of 1,000,000,000 RATE (18 decimals) is minted once, in the constructor, to
/// `msg.sender`. That address is the launch factory, which is the only address it can check the
/// supply against. There is no constructor argument, no mint function, no owner, no pause, no
/// upgrade path and no hook on transfer: after deployment the supply can only shrink through
/// ordinary burns to an address nobody controls.
contract Ratelimit is ERC20 {
    /// @notice Total supply, fixed at deployment: 1,000,000,000 RATE with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    constructor() ERC20("Ratelimit", "RATE") {
        _mint(msg.sender, TOTAL_SUPPLY);
    }
}
