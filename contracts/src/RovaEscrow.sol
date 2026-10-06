// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title RovaEscrow
/// @notice ERC-20 escrow for one Rova order. The verifier is a single trusted key.
///         Latency, freshness, and schema are stored so the order commits to them.
///         The contract cannot see the HTTP response, so only that verifier may settle.
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
    error NotVerifier();
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
    event OrderSettled(uint256 indexed id, address indexed provider, uint256 amount, bytes32 evidenceHash);
    event OrderRefunded(uint256 indexed id, address indexed agent, uint256 amount, bytes32 evidenceHash);
    event OrderExpiredRefunded(uint256 indexed id, address indexed agent, uint256 amount);

    address public immutable verifier;
    address public immutable paymentToken;

    uint256 public nextOrderId = 1;
    mapping(uint256 id => Order order) private _orders;

    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address verifier_, address paymentToken_) {
        if (verifier_ == address(0)) revert NotVerifier();
        if (paymentToken_ == address(0)) revert InvalidToken();
        verifier = verifier_;
        paymentToken = paymentToken_;
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

    /// @dev passed pays the provider. failed returns the funds to the agent. Same transaction either way.
    function settle(uint256 id, bool passed, bytes32 evidenceHash) external nonReentrant {
        if (msg.sender != verifier) revert NotVerifier();
        Order storage order = _orders[id];
        if (order.status != OrderStatus.FUNDED) revert InvalidOrder();
        if (block.timestamp > order.expiresAt) revert Expired();

        if (passed) {
            order.status = OrderStatus.SETTLED;
            _push(order.token, order.provider, order.amount);
            emit OrderSettled(id, order.provider, order.amount, evidenceHash);
        } else {
            order.status = OrderStatus.REFUNDED;
            _push(order.token, order.agent, order.amount);
            emit OrderRefunded(id, order.agent, order.amount, evidenceHash);
        }
    }

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
