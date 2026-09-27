// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/IERC6093.sol";
import {Ratelimit} from "../src/Ratelimit.sol";

contract RatelimitTest is Test {
    uint256 internal constant EXPECTED_SUPPLY = 1_000_000_000 * 1e18;

    Ratelimit internal token;
    address internal deployer = makeAddr("factory");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.prank(deployer);
        token = new Ratelimit();
    }

    function test_metadata() public view {
        assertEq(token.name(), "Ratelimit");
        assertEq(token.symbol(), "RATE");
        assertEq(token.decimals(), 18);
    }

    function test_mintsWholeSupplyToDeployerOnce() public view {
        assertEq(token.TOTAL_SUPPLY(), EXPECTED_SUPPLY);
        assertEq(token.totalSupply(), EXPECTED_SUPPLY);
        assertEq(token.balanceOf(deployer), EXPECTED_SUPPLY);
    }

    function test_hasNoMintOrAdminEntryPoints() public {
        string[8] memory signatures = [
            "mint(address,uint256)",
            "mint(uint256)",
            "burnFrom(address,uint256)",
            "owner()",
            "transferOwnership(address)",
            "pause()",
            "upgradeTo(address)",
            "initialize(address)"
        ];
        for (uint256 i = 0; i < signatures.length; i++) {
            bytes memory data = abi.encodeWithSignature(signatures[i], deployer, uint256(1));
            vm.prank(deployer);
            (bool ok,) = address(token).call(data);
            assertFalse(ok, signatures[i]);
        }
        assertEq(token.totalSupply(), EXPECTED_SUPPLY, "supply moved");
    }

    function test_transferMovesExactAmount() public {
        uint256 amount = 12_345e18;
        vm.prank(deployer);
        assertTrue(token.transfer(alice, amount));
        assertEq(token.balanceOf(alice), amount);
        assertEq(token.balanceOf(deployer), EXPECTED_SUPPLY - amount);
        assertEq(token.totalSupply(), EXPECTED_SUPPLY);
    }

    function testFuzz_transferConservesSupply(uint256 amount) public {
        amount = bound(amount, 0, EXPECTED_SUPPLY);
        vm.prank(deployer);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(alice) + token.balanceOf(deployer), EXPECTED_SUPPLY);
    }

    function test_transferRevertsBeyondBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 1));
        token.transfer(deployer, 1);
    }

    function test_approveAndTransferFrom() public {
        vm.prank(deployer);
        token.approve(alice, 5e18);
        vm.prank(alice);
        token.transferFrom(deployer, alice, 5e18);
        assertEq(token.balanceOf(alice), 5e18);
        assertEq(token.allowance(deployer, alice), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, alice, 0, 1));
        token.transferFrom(deployer, alice, 1);
    }

    function test_runtimeCodeHasNoDelegatecallOrSelfdestruct() public view {
        bytes memory runtime = address(token).code;
        assertGt(runtime.length, 0);
        for (uint256 i = 0; i < runtime.length; i++) {
            uint8 op = uint8(runtime[i]);
            if (op >= 0x60 && op <= 0x7F) {
                i += (op - 0x5F);
                continue;
            }
            assertTrue(op != 0xF4 && op != 0xF2 && op != 0xFF, "forbidden opcode");
        }
    }
}
