// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockToken} from "../src/MockToken.sol";
import {Rova} from "../src/Rova.sol";

contract RovaTest is Test {
    uint256 internal constant CAP = 10 ether;
    uint256 internal constant FLOAT = 30 ether;

    MockToken internal token;
    Rova internal rova;
    address internal vendor;

    function setUp() public {
        token = new MockToken();
        rova = new Rova(address(token), CAP);
        vendor = makeAddr("vendor");
    }

    function test_fundIncreasesDeposited() public {
        _fund(FLOAT);
        assertEq(rova.deposited(), FLOAT);
        assertEq(rova.poolBalance(), FLOAT);
        assertEq(rova.available(), CAP);
        assertEq(rova.cap(), CAP);
        assertEq(rova.reserved(), 0);
        assertEq(rova.spent(), 0);
    }

    function test_manyReservesNeverExceedCap() public {
        _fund(FLOAT);
        uint256 expiry = block.timestamp + 1 hours;
        uint256[] memory ids = new uint256[](10);
        uint256 accepted;
        uint256 refused;

        for (uint256 i = 0; i < 20; i++) {
            address agent = address(uint160(i + 1));
            vm.prank(agent);
            uint256 id = rova.tryReserve(agent, 1 ether, expiry);
            assertLe(rova.reserved(), CAP);
            assertEq(rova.overshoot(), 0);
            if (id == 0) {
                refused++;
            } else {
                ids[accepted] = id;
                accepted++;
            }
        }

        assertEq(accepted, 10);
        assertEq(refused, 10);
        assertEq(rova.reserved(), CAP);
        assertEq(rova.available(), 0);
        assertEq(rova.spent(), 0);

        for (uint256 i = 0; i < accepted; i++) {
            vm.prank(address(uint160(i + 1)));
            rova.commit(ids[i], 1 ether, vendor);
            assertLe(rova.spent(), CAP);
            assertEq(rova.overshoot(), 0);
        }

        assertEq(token.balanceOf(vendor), CAP);
        assertEq(rova.spent(), CAP);
        assertEq(rova.reserved(), 0);
        assertEq(rova.available(), 0);
        assertEq(rova.poolBalance(), FLOAT - CAP);
    }

    function test_overReserveReverts() public {
        _fund(FLOAT);
        uint256 expiry = block.timestamp + 1 hours;

        vm.expectRevert(abi.encodeWithSelector(Rova.InsufficientAvailable.selector, CAP, 11 ether));
        rova.reserve(makeAddr("big"), 11 ether, expiry);

        rova.reserve(makeAddr("full"), CAP, expiry);
        vm.expectRevert(abi.encodeWithSelector(Rova.InsufficientAvailable.selector, 0, 1 ether));
        rova.reserve(makeAddr("late"), 1 ether, expiry);
    }

    function test_tryReserveEmitsRefusal() public {
        _fund(FLOAT);
        uint256 expiry = block.timestamp + 1 hours;
        rova.reserve(makeAddr("full"), CAP, expiry);

        address agent = makeAddr("late");
        vm.expectEmit(true, true, false, true);
        emit Rova.Refused(address(this), agent, 1 ether, 0);
        uint256 id = rova.tryReserve(agent, 1 ether, expiry);
        assertEq(id, 0);
        assertEq(rova.reserved(), CAP);
    }

    function test_commitRefundsDifferenceToPool() public {
        _fund(FLOAT);
        uint256 id = rova.reserve(makeAddr("agent"), 5 ether, block.timestamp + 1 hours);

        vm.expectEmit(true, true, false, true);
        emit Rova.Committed(id, vendor, 2 ether, 3 ether);
        rova.commit(id, 2 ether, vendor);

        assertEq(token.balanceOf(vendor), 2 ether);
        assertEq(rova.poolBalance(), FLOAT - 2 ether);
        assertEq(rova.spent(), 2 ether);
        assertEq(rova.reserved(), 0);
        assertEq(rova.available(), CAP - 2 ether);
    }

    function test_commitAboveReservationReverts() public {
        _fund(FLOAT);
        uint256 id = rova.reserve(makeAddr("agent"), 2 ether, block.timestamp + 1 hours);
        vm.expectRevert(Rova.CostExceedsReservation.selector);
        rova.commit(id, 3 ether, vendor);
        assertEq(rova.spent(), 0);
        assertEq(token.balanceOf(vendor), 0);
    }

    function test_strangerCannotCommitOrRelease() public {
        _fund(FLOAT);
        address agent = makeAddr("agent");
        address stranger = makeAddr("stranger");
        vm.prank(agent);
        uint256 id = rova.reserve(agent, 1 ether, block.timestamp + 1 hours);

        vm.prank(stranger);
        vm.expectRevert(Rova.NotAuthorized.selector);
        rova.commit(id, 1 ether, vendor);

        vm.prank(stranger);
        vm.expectRevert(Rova.NotAuthorized.selector);
        rova.release(id);

        assertEq(rova.reserved(), 1 ether);
        assertEq(token.balanceOf(vendor), 0);
    }

    function test_ownerCanCommit() public {
        _fund(FLOAT);
        address agent = makeAddr("agent");
        vm.prank(agent);
        uint256 id = rova.reserve(agent, 1 ether, block.timestamp + 1 hours);

        rova.commit(id, 1 ether, vendor);
        assertEq(token.balanceOf(vendor), 1 ether);
        assertEq(rova.spent(), 1 ether);
        assertEq(rova.reserved(), 0);
    }

    function test_expiryReleasesToAnyone() public {
        _fund(FLOAT);
        address agent = makeAddr("agent");
        address stranger = makeAddr("stranger");
        uint256 expiry = block.timestamp + 50;
        uint256 id = rova.reserve(agent, 4 ether, expiry);

        vm.warp(expiry);
        vm.expectEmit(true, true, false, true);
        emit Rova.Released(id, agent, 4 ether, true);
        vm.prank(stranger);
        rova.release(id);

        assertEq(rova.available(), CAP);
        assertEq(rova.reserved(), 0);
        assertEq(rova.reservedActive(), 0);
        assertEq(rova.poolBalance(), FLOAT);

        (,,,,,, Rova.Status state,) = rova.reservation(id);
        assertEq(uint256(state), uint256(Rova.Status.Released));

        vm.expectRevert(Rova.NotActive.selector);
        rova.release(id);
    }

    function test_expiryFreesCapForNewReserve() public {
        _fund(FLOAT);
        uint256 expiry = block.timestamp + 15;
        address crashed = makeAddr("crashed");
        uint256 oldId = rova.reserve(crashed, CAP, expiry);

        vm.warp(expiry);
        assertEq(rova.available(), CAP);
        assertEq(rova.reserved(), 0);
        assertEq(rova.reservedActive(), CAP);

        uint256 id = rova.tryReserve(makeAddr("next"), CAP, block.timestamp + 1 hours);
        assertGt(id, 0);

        (,,,,,, Rova.Status state,) = rova.reservation(oldId);
        assertEq(uint256(state), uint256(Rova.Status.Released));
        assertEq(rova.reserved(), CAP);
        assertEq(rova.available(), 0);
        assertEq(rova.spent(), 0);
    }

    function test_commitAfterExpiryReverts() public {
        _fund(FLOAT);
        uint256 expiry = block.timestamp + 10;
        uint256 id = rova.reserve(makeAddr("agent"), 1 ether, expiry);
        vm.warp(expiry);

        vm.expectRevert(Rova.Expired.selector);
        rova.commit(id, 1 ether, vendor);

        assertEq(rova.spent(), 0);
        assertEq(token.balanceOf(vendor), 0);
        assertEq(rova.available(), CAP);
        assertEq(rova.reservedActive(), 1 ether);
    }

    function test_naiveSpendOvershootsCap() public {
        _fund(FLOAT);
        for (uint256 i = 0; i < 20; i++) {
            rova.spendNaive(address(uint160(i + 1)), 1 ether, vendor);
        }
        assertEq(rova.spent(), 20 ether);
        assertEq(rova.naiveAttempted(), 20 ether);
        assertEq(rova.naivePaid(), 20 ether);
        assertEq(rova.overshoot(), 10 ether);
        assertEq(rova.available(), 0);
        assertEq(token.balanceOf(vendor), 20 ether);
        assertEq(rova.poolBalance(), 10 ether);
    }

    function test_naiveCannotTakeReservedTokens() public {
        _fund(FLOAT);
        rova.reserve(makeAddr("agent"), CAP, block.timestamp + 1 hours);
        rova.spendNaive(makeAddr("other"), 25 ether, vendor);

        assertEq(token.balanceOf(vendor), 20 ether);
        assertEq(rova.naivePaid(), 20 ether);
        assertEq(rova.spent(), 20 ether);
        assertEq(rova.reserved(), CAP);
        assertEq(rova.poolBalance(), CAP);
    }

    function test_resetClearsAccounting() public {
        _fund(FLOAT);
        for (uint256 i = 0; i < 20; i++) {
            rova.spendNaive(address(uint160(i + 1)), 1 ether, vendor);
        }

        rova.reset(address(this));

        assertEq(rova.spent(), 0);
        assertEq(rova.deposited(), 0);
        assertEq(rova.naiveAttempted(), 0);
        assertEq(rova.naivePaid(), 0);
        assertEq(rova.poolBalance(), 0);
        assertEq(rova.cap(), CAP);
        assertEq(token.balanceOf(address(this)), 10 ether);
        assertEq(token.balanceOf(vendor), 20 ether);
    }

    function test_resetRequiresNoActiveReserve() public {
        _fund(FLOAT);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Rova.NotAuthorized.selector);
        rova.reset(address(this));

        rova.reserve(makeAddr("agent"), 1 ether, block.timestamp + 1 hours);
        vm.expectRevert(Rova.ReservedOutstanding.selector);
        rova.reset(address(this));
    }

    function test_badExpiryReverts() public {
        _fund(FLOAT);
        vm.expectRevert(Rova.BadExpiry.selector);
        rova.reserve(makeAddr("agent"), 1 ether, block.timestamp);
    }

    function _fund(uint256 amount) internal {
        token.mint(address(this), amount);
        token.approve(address(rova), amount);
        rova.fund(amount);
    }
}
