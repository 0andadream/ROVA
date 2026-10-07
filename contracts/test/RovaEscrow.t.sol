// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "../src/ECDSA.sol";
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
    uint256 internal constant K1 = 0xA11CE;
    uint256 internal constant K2 = 0xB0B;
    uint256 internal constant K3 = 0xC0FFEE;
    uint256 internal constant OUTSIDER = 0xD00D;
    address v1;
    address v2;
    address v3;
    address agent = makeAddr("agent");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");
    address relayer = makeAddr("relayer");

    uint256 constant AMOUNT = 20_000;
    uint256 constant LATENCY = 3000;
    uint256 constant AGE = 60;
    bytes32 schemaHash = keccak256("eth-usd");
    bytes32 constant VERDICT_TYPEHASH = keccak256("Verdict(uint256 orderId,bool passed,bytes32 evidenceHash)");

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
    event OrderSettled(
        uint256 indexed id,
        address indexed provider,
        uint256 amount,
        bytes32[] evidenceHashes,
        address[] signers
    );
    event OrderRefunded(
        uint256 indexed id,
        address indexed agent,
        uint256 amount,
        bytes32[] evidenceHashes,
        address[] signers
    );
    event OrderExpiredRefunded(uint256 indexed id, address indexed agent, uint256 amount);

    function setUp() public {
        v1 = vm.addr(K1);
        v2 = vm.addr(K2);
        v3 = vm.addr(K3);
        token = new MockToken();
        escrow = _deploy(address(token));
        token.mint(agent, 1_000_000);
        vm.prank(agent);
        token.approve(address(escrow), type(uint256).max);
    }

    function _verifiers() internal view returns (address[] memory verifiers) {
        verifiers = new address[](3);
        verifiers[0] = v1;
        verifiers[1] = v2;
        verifiers[2] = v3;
    }

    function _deploy(address paymentToken) internal returns (RovaEscrow deployed) {
        deployed = new RovaEscrow(_verifiers(), 2, paymentToken);
    }

    function _expiry() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _create() internal returns (uint256 id) {
        vm.prank(agent);
        id = escrow.createOrder(provider, address(token), AMOUNT, LATENCY, AGE, schemaHash, _expiry());
    }

    function _sign(uint256 key, bytes32 domain, uint256 id, bool passed, bytes32 evidence)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(VERDICT_TYPEHASH, id, passed, evidence)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pair(uint256 id, bool passed, bytes32 leftHash, bytes32 rightHash, uint256 leftKey, uint256 rightKey)
        internal
        view
        returns (bytes32[] memory hashes, bytes[] memory sigs, address[] memory signers)
    {
        address left = vm.addr(leftKey);
        address right = vm.addr(rightKey);
        bytes memory leftSig = _sign(leftKey, escrow.domainSeparator(), id, passed, leftHash);
        bytes memory rightSig = _sign(rightKey, escrow.domainSeparator(), id, passed, rightHash);
        hashes = new bytes32[](2);
        sigs = new bytes[](2);
        signers = new address[](2);
        if (left < right) {
            hashes[0] = leftHash;
            hashes[1] = rightHash;
            sigs[0] = leftSig;
            sigs[1] = rightSig;
            signers[0] = left;
            signers[1] = right;
        } else {
            hashes[0] = rightHash;
            hashes[1] = leftHash;
            sigs[0] = rightSig;
            sigs[1] = leftSig;
            signers[0] = right;
            signers[1] = left;
        }
    }

    function _malleate(bytes memory signature) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        uint256 n = uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141);
        return abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
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
        assertEq(escrow.threshold(), 2);
        assertEq(escrow.verifierCount(), 3);
        assertTrue(escrow.isVerifier(v1));
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

    function test_twoOfThreePassPaysProviderAndBalancesMoveOnce() public {
        uint256 id = _create();
        uint256 agentAfterLock = token.balanceOf(agent);
        uint256 providerBefore = token.balanceOf(provider);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        (bytes32[] memory hashes, bytes[] memory sigs, address[] memory signers) =
            _pair(id, true, keccak256("a"), keccak256("b"), K1, K2);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit OrderSettled(id, provider, AMOUNT, hashes, signers);

        vm.prank(relayer);
        escrow.settle(id, true, hashes, sigs);

        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
        assertEq(token.balanceOf(provider) - providerBefore, AMOUNT);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(agent), agentAfterLock);
        assertEq(token.balanceOf(provider), AMOUNT);
        assertEq(token.balanceOf(relayer), 0);
    }

    function test_twoOfThreeFailRefundsAgentInSameCall() public {
        uint256 agentBefore = token.balanceOf(agent);
        uint256 providerBefore = token.balanceOf(provider);
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs, address[] memory signers) =
            _pair(id, false, keccak256("c"), keccak256("d"), K2, K3);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit OrderRefunded(id, agent, AMOUNT, hashes, signers);

        vm.prank(relayer);
        escrow.settle(id, false, hashes, sigs);

        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.REFUNDED));
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(provider), providerBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_mixedPassAndFailRejected() public {
        uint256 id = _create();
        bytes32 passHash = keccak256("pass");
        bytes32 failHash = keccak256("fail");
        bytes memory passSig = _sign(K1, escrow.domainSeparator(), id, true, passHash);
        bytes memory failSig = _sign(K2, escrow.domainSeparator(), id, false, failHash);
        bytes32[] memory hashes = new bytes32[](2);
        bytes[] memory sigs = new bytes[](2);
        if (v1 < v2) {
            hashes[0] = passHash;
            hashes[1] = failHash;
            sigs[0] = passSig;
            sigs[1] = failSig;
        } else {
            hashes[0] = failHash;
            hashes[1] = passHash;
            sigs[0] = failSig;
            sigs[1] = passSig;
        }
        vm.expectRevert();
        escrow.settle(id, true, hashes, sigs);
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.FUNDED));
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_belowThresholdRejected() public {
        uint256 id = _create();
        bytes32[] memory hashes = new bytes32[](1);
        bytes[] memory sigs = new bytes[](1);
        hashes[0] = keccak256("one");
        sigs[0] = _sign(K1, escrow.domainSeparator(), id, true, hashes[0]);
        vm.expectRevert(RovaEscrow.BelowThreshold.selector);
        escrow.settle(id, true, hashes, sigs);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_nonMemberSignerRejected() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) =
            _pair(id, true, keccak256("in"), keccak256("out"), K1, OUTSIDER);
        vm.expectRevert(RovaEscrow.NotVerifier.selector);
        escrow.settle(id, true, hashes, sigs);
    }

    function test_duplicateSignerRejected() public {
        uint256 id = _create();
        bytes32 evidence = keccak256("same");
        bytes memory signature = _sign(K1, escrow.domainSeparator(), id, true, evidence);
        bytes32[] memory hashes = new bytes32[](2);
        bytes[] memory sigs = new bytes[](2);
        hashes[0] = evidence;
        hashes[1] = evidence;
        sigs[0] = signature;
        sigs[1] = signature;
        vm.expectRevert(RovaEscrow.DuplicateSigner.selector);
        escrow.settle(id, true, hashes, sigs);
    }

    function test_unsortedSignersRejected() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs, address[] memory signers) =
            _pair(id, true, keccak256("a"), keccak256("b"), K1, K2);
        bytes32[] memory flippedHashes = new bytes32[](2);
        bytes[] memory flippedSigs = new bytes[](2);
        flippedHashes[0] = hashes[1];
        flippedHashes[1] = hashes[0];
        flippedSigs[0] = sigs[1];
        flippedSigs[1] = sigs[0];
        assertTrue(signers[0] < signers[1]);
        vm.expectRevert(RovaEscrow.UnsortedSigners.selector);
        escrow.settle(id, true, flippedHashes, flippedSigs);
    }

    function test_signatureForDifferentOrderRejected() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id + 1, true, keccak256("a"), keccak256("b"), K1, K2);
        vm.expectRevert();
        escrow.settle(id, true, hashes, sigs);
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.FUNDED));
    }

    function test_signatureForDifferentContractRejected() public {
        uint256 id = _create();
        RovaEscrow other = _deploy(address(token));
        bytes32[] memory hashes = new bytes32[](2);
        bytes[] memory sigs = new bytes[](2);
        hashes[0] = keccak256("a");
        hashes[1] = keccak256("b");
        sigs[0] = _sign(K1, other.domainSeparator(), id, true, hashes[0]);
        sigs[1] = _sign(K2, other.domainSeparator(), id, true, hashes[1]);
        if (v1 > v2) {
            (hashes[0], hashes[1]) = (hashes[1], hashes[0]);
            (sigs[0], sigs[1]) = (sigs[1], sigs[0]);
        }
        vm.expectRevert();
        escrow.settle(id, true, hashes, sigs);
    }

    function test_signatureForDifferentChainIdRejected() public {
        uint256 id = _create();
        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("RovaEscrow")),
                keccak256(bytes("1")),
                uint256(1),
                address(escrow)
            )
        );
        bytes32[] memory hashes = new bytes32[](2);
        bytes[] memory sigs = new bytes[](2);
        hashes[0] = keccak256("a");
        hashes[1] = keccak256("b");
        sigs[0] = _sign(K1, foreignDomain, id, true, hashes[0]);
        sigs[1] = _sign(K2, foreignDomain, id, true, hashes[1]);
        if (v1 > v2) {
            (hashes[0], hashes[1]) = (hashes[1], hashes[0]);
            (sigs[0], sigs[1]) = (sigs[1], sigs[0]);
        }
        vm.expectRevert();
        escrow.settle(id, true, hashes, sigs);
    }

    function test_failSignatureCannotSettleAsPass() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, false, keccak256("a"), keccak256("b"), K1, K2);
        vm.expectRevert();
        escrow.settle(id, true, hashes, sigs);
        assertEq(token.balanceOf(provider), 0);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_malleatedSignatureRejected() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, true, keccak256("a"), keccak256("b"), K1, K2);
        bytes memory malleated = _malleate(sigs[0]);
        bytes32 highS;
        assembly {
            highS := mload(add(malleated, 0x40))
        }
        sigs[0] = malleated;
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        escrow.settle(id, true, hashes, sigs);
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.FUNDED));
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
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, true, keccak256("once"), keccak256("once-b"), K1, K2);
        escrow.settle(id, true, hashes, sigs);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(id, true, hashes, sigs);
    }

    function test_doubleSettlementAfterFailReverts() public {
        uint256 id = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, false, keccak256("once"), keccak256("once-b"), K1, K3);
        escrow.settle(id, false, hashes, sigs);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(id, false, hashes, sigs);
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
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, true, keccak256("edge"), keccak256("edge-b"), K1, K2);
        escrow.settle(id, true, hashes, sigs);
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
    }

    function test_settlementAfterExpiryReverts() public {
        uint256 id = _create();
        vm.warp(escrow.getOrder(id).expiresAt + 1);
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, true, keccak256("late"), keccak256("late-b"), K1, K2);
        vm.expectRevert(RovaEscrow.Expired.selector);
        escrow.settle(id, true, hashes, sigs);
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
        RovaEscrow poorEscrow = _deploy(address(poor));
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
        bytes32[] memory hashes = new bytes32[](2);
        bytes[] memory sigs = new bytes[](2);
        vm.expectRevert(RovaEscrow.InvalidOrder.selector);
        escrow.settle(0, true, hashes, sigs);
    }

    function test_failedOrderIsNotReused() public {
        uint256 firstId = _create();
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(firstId, false, keccak256("fail"), keccak256("fail-b"), K1, K2);
        escrow.settle(firstId, false, hashes, sigs);
        uint256 secondId = _create();
        assertEq(firstId, 1);
        assertEq(secondId, 2);
        assertEq(uint256(escrow.getOrder(firstId).status), uint256(RovaEscrow.OrderStatus.REFUNDED));
        assertEq(uint256(escrow.getOrder(secondId).status), uint256(RovaEscrow.OrderStatus.FUNDED));
    }

    function test_reentrancyOnSettleCannotDoublePay() public {
        uint256 id = _create();
        token.setHook(
            address(escrow),
            abi.encodeWithSelector(RovaEscrow.settle.selector, id, true, new bytes32[](0), new bytes[](0))
        );
        (bytes32[] memory hashes, bytes[] memory sigs,) = _pair(id, true, keccak256("once"), keccak256("once-b"), K1, K2);
        escrow.settle(id, true, hashes, sigs);

        assertFalse(token.lastHookOk());
        assertEq(uint256(escrow.getOrder(id).status), uint256(RovaEscrow.OrderStatus.SETTLED));
        assertEq(token.balanceOf(provider), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_constructorRejectsEmptyDuplicateZeroAndBadThreshold() public {
        address[] memory none = new address[](0);
        vm.expectRevert(RovaEscrow.InvalidVerifierSet.selector);
        new RovaEscrow(none, 1, address(token));

        address[] memory zero = new address[](1);
        zero[0] = address(0);
        vm.expectRevert(RovaEscrow.InvalidVerifierSet.selector);
        new RovaEscrow(zero, 1, address(token));

        address[] memory dup = new address[](2);
        dup[0] = v1;
        dup[1] = v1;
        vm.expectRevert(RovaEscrow.InvalidVerifierSet.selector);
        new RovaEscrow(dup, 1, address(token));

        vm.expectRevert(RovaEscrow.InvalidThreshold.selector);
        new RovaEscrow(_verifiers(), 0, address(token));
        vm.expectRevert(RovaEscrow.InvalidThreshold.selector);
        new RovaEscrow(_verifiers(), 4, address(token));
        vm.expectRevert(RovaEscrow.InvalidToken.selector);
        new RovaEscrow(_verifiers(), 2, address(0));
    }
}
