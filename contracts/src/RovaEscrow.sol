// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "./ECDSA.sol";

/// @title RovaEscrow
/// @notice ERC-20 escrow for one Rova order. Settlement requires a k-of-n verifier quorum.
///         Each verifier signs Verdict(orderId, passed, evidenceHash). Anyone may relay the
///         signatures. If no quorum arrives before expiresAt, anyone can refund the buyer.
contract RovaEscrow {
    enum OrderStatus {
        NONE,
        FUNDED,
        SETTLED,
        REFUNDED,
        EXPIRED_REFUNDED
    }

    struct Order {
        uint256 id;
        address agent;
        address provider;
        address token;
        uint256 amount;
        uint256 maxLatencyMs;
        uint256 maxAgeSec;
        bytes32 schemaHash;
        uint256 expiresAt;
        OrderStatus status;
    }

    error ZeroAmount();
    error InvalidProvider();
    error InvalidToken();
    error InvalidExpiry();
    error InvalidVerifierSet();
    error InvalidThreshold();
    error NotVerifier();
    error BelowThreshold();
    error UnsortedSigners();
    error DuplicateSigner();
    error QuorumShape();
    error InvalidOrder();
    error Expired();
    error NotExpired();
    error TransferFailed();
    error Reentrancy();

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

    bytes32 private constant VERDICT_TYPEHASH = keccak256("Verdict(uint256 orderId,bool passed,bytes32 evidenceHash)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public immutable paymentToken;
    uint8 public immutable threshold;
    bytes32 public immutable domainSeparator;

    address[] private _verifiers;
    mapping(address verifier => bool member) public isVerifier;
    mapping(uint256 id => Order order) private _orders;

    uint256 public nextOrderId = 1;
    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @dev The verifier set and threshold are fixed here. There is no setter.
    constructor(address[] memory verifiers_, uint8 threshold_, address paymentToken_) {
        uint256 count = verifiers_.length;
        if (count == 0 || count > 255) revert InvalidVerifierSet();
        if (threshold_ < 1 || threshold_ > count) revert InvalidThreshold();
        if (paymentToken_ == address(0)) revert InvalidToken();
        for (uint256 i = 0; i < count; i++) {
            address verifier = verifiers_[i];
            if (verifier == address(0) || isVerifier[verifier]) revert InvalidVerifierSet();
            isVerifier[verifier] = true;
            _verifiers.push(verifier);
        }
        paymentToken = paymentToken_;
        threshold = threshold_;
        domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("RovaEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function verifierCount() external view returns (uint256) {
        return _verifiers.length;
    }

    function verifierAt(uint256 index) external view returns (address) {
        return _verifiers[index];
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function createOrder(
        address provider,
        address token,
        uint256 amount,
        uint256 maxLatencyMs,
        uint256 maxAgeSec,
        bytes32 schemaHash,
        uint256 expiresAt
    ) external nonReentrant returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (provider == address(0) || provider == msg.sender) revert InvalidProvider();
        if (token != paymentToken) revert InvalidToken();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        id = nextOrderId++;
        _orders[id] = Order({
            id: id,
            agent: msg.sender,
            provider: provider,
            token: token,
            amount: amount,
            maxLatencyMs: maxLatencyMs,
            maxAgeSec: maxAgeSec,
            schemaHash: schemaHash,
            expiresAt: expiresAt,
            status: OrderStatus.FUNDED
        });

        _pull(token, msg.sender, amount);
        emit OrderCreated(id, msg.sender, provider, token, amount, maxLatencyMs, maxAgeSec, schemaHash, expiresAt);
    }

    /// @notice Anyone can relay a quorum. Signature i signs Verdict(id, passed, evidenceHashes[i]).
    ///         Signers must be strictly ascending. Every signature must agree on `passed`.
    function settle(uint256 id, bool passed, bytes32[] calldata evidenceHashes, bytes[] calldata signatures)
        external
        nonReentrant
    {
        Order storage order = _orders[id];
        if (order.status != OrderStatus.FUNDED) revert InvalidOrder();
        if (block.timestamp > order.expiresAt) revert Expired();

        uint256 count = signatures.length;
        if (evidenceHashes.length != count) revert QuorumShape();
        if (count < threshold) revert BelowThreshold();

        address[] memory signers = new address[](count);
        address previous = address(0);
        for (uint256 i = 0; i < count; i++) {
            bytes32 digest = keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    keccak256(abi.encode(VERDICT_TYPEHASH, id, passed, evidenceHashes[i]))
                )
            );
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isVerifier[signer]) revert NotVerifier();
            if (signer == previous) revert DuplicateSigner();
            if (signer < previous) revert UnsortedSigners();
            signers[i] = signer;
            previous = signer;
        }

        if (passed) {
            order.status = OrderStatus.SETTLED;
            _push(order.token, order.provider, order.amount);
            emit OrderSettled(id, order.provider, order.amount, evidenceHashes, signers);
        } else {
            order.status = OrderStatus.REFUNDED;
            _push(order.token, order.agent, order.amount);
            emit OrderRefunded(id, order.agent, order.amount, evidenceHashes, signers);
        }
    }

    /// @notice Liveness fail-safe. If the quorum never arrives, anyone refunds the buyer after expiry.
    function refundExpired(uint256 id) external nonReentrant {
        Order storage order = _orders[id];
        if (order.status != OrderStatus.FUNDED) revert InvalidOrder();
        if (block.timestamp <= order.expiresAt) revert NotExpired();
        order.status = OrderStatus.EXPIRED_REFUNDED;
        _push(order.token, order.agent, order.amount);
        emit OrderExpiredRefunded(id, order.agent, order.amount);
    }

    function _pull(address token, address from, uint256 amount) internal {
        uint256 beforeBalance = _balanceOf(token, address(this));
        _callToken(token, abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        uint256 received = _balanceOf(token, address(this)) - beforeBalance;
        if (received != amount) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) internal {
        uint256 beforeBalance = _balanceOf(token, to);
        _callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
        uint256 credited = _balanceOf(token, to) - beforeBalance;
        if (credited != amount) revert TransferFailed();
    }

    function _callToken(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
