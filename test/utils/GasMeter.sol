// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev With `forge test --no-isolate`, these are CALL-envelope measurements, before refunds
/// and excluding transaction intrinsic gas. Isolation mode adds transaction accounting.
/// Calldata is encoded before the interval. Logging and assertions are after it. No snapshot
/// cheatcodes or filesystem permissions are needed: forge snapshot records the enclosing tests.
abstract contract GasMeter is Test {
    function _meter(address target, bytes memory input, uint256 value) internal returns (bool ok, bytes memory output) {
        uint256 start = gasleft();
        (ok, output) = target.call{value: value}(input);
        uint256 used = start - gasleft();
        emit log_named_uint("call gas", used);
    }

    function _success(address target, bytes memory input) internal returns (bytes memory output) {
        bool ok;
        (ok, output) = _meter(target, input, 0);
        assertTrue(ok, "measured call reverted");
    }
}
