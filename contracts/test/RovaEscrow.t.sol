// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RovaEscrow} from "../src/RovaEscrow.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnFalse;
    uint256 public withhold;
    address public hook;
    bytes public hookData;
    bool public lastHookOk;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function setWithhold(uint256 value) external {
        withhold = value;
    }

    function setHook(address hook_, bytes calldata data) external {
        hook = hook_;
        hookData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        _move(msg.sender, to, amount);
        _hook();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        _hook();
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        uint256 sent = amount - withhold;
        balanceOf[from] -= amount;
        balanceOf[to] += sent;
    }

    function _hook() internal {
        if (hook == address(0)) return;
        (bool ok,) = hook.call(hookData);
        lastHookOk = ok;
    }
}

contract RovaEscrowTest is Test {
    RovaEscrow escrow;
    MockToken token;
    address verifier = makeAddr("verifier");
    address agent = makeAddr("agent");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");

    uint256 constant AMOUNT = 20_000;
    uint256 constant LATENCY = 3000;
    uint256 constant AGE = 60;
    bytes32 schemaHash = keccak256("eth-usd");

    event OrderCreated(
        uint256 indexed id,
        address indexed agent,
        address indexed provider,
        address token,
        uint256 amount,
        uint256 maxLatencyMs,
        uint256 maxAgeSec,
        bytes32 schemaHash,
        uint256 expiresAt
    );
    event OrderSettled(uint256 indexed id, address indexed provider, uint256 amount, bytes32 evidenceHash);
    event OrderRefunded(uint256 indexed id, address indexed agent, uint256 amount, bytes32 evidenceHash);
    event OrderExpiredRefunded(uint256 indexed id, address indexed agent, uint256 amount);

    function setUp() public {
        token = new MockToken();
        escrow = new RovaEscrow(verifier, address(token));
        token.mint(agent, 1_000_000);
        vm.prank(agent);
        token.approve(address(escrow), type(uint256).max);
    }

    function _expiry() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _create() internal returns (uint256 id) {
        vm.prank(agent);
        id = escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_createOrderPullsExactAmountAndStoresOrder() public {
        uint256 agentBefore = token.balanceOf(agent);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 expiry = _expiry();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit OrderCreated(1, agent, provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, expiry);

        vm.prank(agent);
        uint256 id = escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, expiry);

        assertEq(id, 1);
        assertEq(escrow.nextOrderId(), 2);
        RovaEscrow.Order memory order = escrow.getOrder(id);
        assertEq(order.id, 1);
        assertEq(order.agent, agent);
        assertEq(order.provider, provider);
        assertEq(order.token, address(token));
        assertEq(order.amount, AMOUNT);
        assertEq(order.maxLatencyMs, LATENCY);
        assertEq(order.maxAgeSec, AGE);
        assertEq(order.schemaHash, schemaHash);
        assertEq(order.expiresAt, expiry);
        assertEq(uint256(order.status), uint256(RovaEscrow.OrderStatus.FUNDED));
        assertEq(agentBefore - token.balanceOf(agent), AMOUNT);
        assertEq(token.balanceOf(address(escrow)) - escrowBefore, AMOUNT);
    }

    function test_passPaysProviderAndBalancesMoveOnce() public {
        uint256 id = _create();
        uint256 agentAfterLock = token.balanceOf(agent);
        uint256 providerBefore = token.balanceOf(provider);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        bytes32 evidence = keccak256("pass");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit OrderSettled(id, provider, AMOUNT, evidence);

        vm.prank(verifier);
        escrow.settle(id, true, evidence);

        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
        assertEq(token.balanceOf(provider) - providerBefore, AMOUNT);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(agent), agentAfterLock);
        assertEq(token.balanceOf(provider), AMOUNT);
    }

    function test_failRefundsAgentInSameCall() public {
        uint256 agentBefore = token.balanceOf(agent);
        uint256 providerBefore = token.balanceOf(provider);
        uint256 id = _create();
        bytes32 evidence = keccak256("fail");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit OrderRefunded(id, agent, AMOUNT, evidence);

        vm.prank(verifier);
        escrow.settle(id, false, evidence);

        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.REFUNDED));
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(provider), providerBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_expiredRefundReturnsFundsToAgent() public {
        uint256 agentBefore = token.balanceOf(agent);
        uint256 id = _create();
        vm.warp(escrow.getOrder(id).expiresAt + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit OrderExpiredRefunded(id, agent, AMOUNT);

        vm.prank(stranger);
        escrow.refundExpired(id);

        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.EXPIRED_REFUNDED));
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(stranger), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_doubleSettlementReverts() public {
        uint256 id = _create();
        vm.prank(verifier);
        escrow.settle(id, true, bytes32("once"));
        vm.prank(verifier);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(id, true, bytes32("twice"));
    }

    function test_doubleSettlementAfterFailReverts() public {
        uint256 id = _create();
        vm.prank(verifier);
        escrow.settle(id, false, bytes32("once"));
        vm.prank(verifier);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(id, false, bytes32("twice"));
    }

    function test_nonVerifierCannotSettle() public {
        uint256 id = _create();
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.NotVerifier.selector);
        escrow.settle(id, true, bytes32(0));
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.FUNDED));
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_refundBeforeExpiryReverts() public {
        uint256 id = _create();
        vm.warp(escrow.getOrder(id).expiresAt);
        vm.expectRevert(RovaEscrow.NotExpired.selector);
        escrow.refundExpired(id);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_settlementAtExpiryStillAllowed() public {
        uint256 id = _create();
        vm.warp(escrow.getOrder(id).expiresAt);
        vm.prank(verifier);
        escrow.settle(id, true, bytes32("edge"));
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
    }

    function test_settlementAfterExpiryReverts() public {
        uint256 id = _create();
        vm.warp(escrow.getOrder(id).expiresAt + 1);
        vm.prank(verifier);
        vm.expectRevert(RovaEscrow.Expired.selector);
        escrow.settle(id, true, bytes32(0));
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.FUNDED));
    }

    function test_insufficientAllowanceReverts() public {
        vm.prank(agent);
        token.approve(address(escrow), AMOUNT - 1);
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.TransferFailed.selector);
        escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
        assertEq(escrow.nextOrderId(), 1);
    }

    function test_insufficientBalanceReverts() public {
        MockToken poor = new MockToken();
        RovaEscrow poorEscrow = new RovaEscrow(verifier, address(poor));
        poor.mint(agent, AMOUNT - 1);
        vm.prank(agent);
        poor.approve(address(poorEscrow), type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.TransferFailed.selector);
        poorEscrow.createOrder(provider, address(poor), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_zeroAmountReverts() public {
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.ZeroAmount.selector);
        escrow.createOrder(provider, address(token), 0, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_wrongReceivedAmountReverts() public {
        token.setWithhold(1);
        uint256 agentBefore = token.balanceOf(agent);
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.TransferFailed.selector);
        escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.nextOrderId(), 1);
    }

    function test_tokenReturningFalseReverts() public {
        token.setReturnFalse(true);
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.TransferFailed.selector);
        escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_invalidProviderReverts() public {
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.InvalidProvider.selector);
        escrow.createOrder(address(0), address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());

        vm.prank(agent);
        vm.expectRevert(RovaEscrow.InvalidProvider.selector);
        escrow.createOrder(agent, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_invalidTokenReverts() public {
        MockToken other = new MockToken();
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.InvalidToken.selector);
        escrow.createOrder(provider, address(other), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function test_invalidExpiryReverts() public {
        vm.prank(agent);
        vm.expectRevert(RovaEscrow.InvalidExpiry.selector);
        escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, block.timestamp);

        vm.prank(agent);
        vm.expectRevert(RovaEscrow.InvalidExpiry.selector);
        escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, block.timestamp - 1);
    }

    function test_invalidOrderIdReverts() public {
        vm.prank(verifier);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(0, true, bytes32(0));
    }

    function test_failedOrderIsNotReused() public {
        uint256 firstId = _create();
        vm.prank(verifier);
        escrow.settle(firstId, false, bytes32("fail"));
        uint256 secondId = _create();
        assertEq(firstId, 1);
        assertEq(secondId, 2);
        assertEq(uint256(escrow.getOrder(firstId).status), uint256(RovaEscrow.OrderStatus.REFUNDED));
        assertEq(uint256(escrow.getOrder(secondId).status), uint256(RovaEscrow.OrderStatus.FUNDED));
    }

    function test_reentrancyOnSettleCannotDoublePay() public {
        uint256 id = _create();
        token.setHook(address(escrow), abi.encodeWithSelector(RovaEscrow.settle.selector, id, true, bytes32("again")));

        vm.prank(verifier);
        escrow.settle(id, true, bytes32("once"));

        assertFalse(token.lastHookOk());
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
        assertEq(token.balanceOf(provider), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(RovaEscrow.NotVerifier.selector);
        new RovaEscrow(address(0), address(token));
        vm.expectRevert(RovaEscrow.InvalidToken.selector);
        new RovaEscrow(verifier, address(0));
    }
}
