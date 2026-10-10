// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Rova
/// @notice One shared pool, one hard cap. A spend is allowed only after it reserves
///         funds. The pool pays vendors. Agents never hold the money.
/// @dev The token balance may be larger than `cap`. That slack is what lets the
///      naive path move real tokens past the policy cap. `reserve` does not.
contract Rova {
    enum Status {
        None,
        Active,
        Settled,
        Released
    }

    struct Reservation {
        address reserver;
        address agent;
        address vendor;
        uint256 amount;
        uint256 actualCost;
        uint256 expiry;
        Status status;
    }

    IERC20 public immutable token;
    address public immutable owner;
    uint256 public immutable cap;

    uint256 public deposited;
    uint256 public spent;
    uint256 public naiveAttempted;
    uint256 public naivePaid;
    uint256 public reservedActive;
    uint256 public nextId;

    mapping(uint256 => Reservation) private reservations;

    error NotAuthorized();
    error BadAmount();
    error BadExpiry();
    error TransferFailed();
    error InsufficientAvailable(uint256 available, uint256 amount);
    error UnknownReservation();
    error NotActive();
    error Expired();
    error CostExceedsReservation();
    error ReservedOutstanding();

    event Funded(address indexed from, uint256 amount);
    event Reserved(
        uint256 indexed id,
        address indexed reserver,
        address indexed agent,
        uint256 amount,
        uint256 expiry
    );
    event Committed(uint256 indexed id, address indexed vendor, uint256 actualCost, uint256 refundedToPool);
    event Released(uint256 indexed id, address indexed agent, uint256 amount, bool expired);
    event Refused(address indexed reserver, address indexed agent, uint256 amount, uint256 available);
    event NaiveSpend(address indexed agent, address indexed vendor, uint256 requested, uint256 paid);
    event Reset(address indexed to, uint256 tokensReturned);

    constructor(address token_, uint256 cap_) {
        if (token_ == address(0) || cap_ == 0) revert BadAmount();
        token = IERC20(token_);
        owner = msg.sender;
        cap = cap_;
    }

    /// @notice Tokens currently inside the policy cap. Expired reservations are not counted.
    function available() public view returns (uint256) {
        uint256 used = spent + _liveReserved();
        if (used >= cap) return 0;
        return cap - used;
    }

    function reserved() public view returns (uint256) {
        return _liveReserved();
    }

    /// @notice How far spent plus live reservations have gone past the cap.
    function overshoot() public view returns (uint256) {
        uint256 used = spent + _liveReserved();
        if (used <= cap) return 0;
        return used - cap;
    }

    function poolBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function reservation(uint256 id)
        external
        view
        returns (
            address reserver,
            address agent,
            address vendor,
            uint256 amount,
            uint256 actualCost,
            uint256 expiry,
            Status status,
            bool expired
        )
    {
        Reservation storage r = reservations[id];
        if (r.status == Status.None) revert UnknownReservation();
        reserver = r.reserver;
        agent = r.agent;
        vendor = r.vendor;
        amount = r.amount;
        actualCost = r.actualCost;
        expiry = r.expiry;
        status = r.status;
        expired = r.status == Status.Active && block.timestamp >= r.expiry;
    }

    function fund(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        _pull(msg.sender, amount);
        deposited += amount;
        emit Funded(msg.sender, amount);
    }

    /// @notice Atomically reserve `amount` until `expiry`. Reverts when the cap cannot cover it.
    function reserve(address agent, uint256 amount, uint256 expiry) external returns (uint256) {
        return _reserve(agent, amount, expiry, true);
    }

    /// @notice Same check as `reserve`. On a shortage it emits `Refused` and returns 0.
    function tryReserve(address agent, uint256 amount, uint256 expiry) external returns (uint256) {
        return _reserve(agent, amount, expiry, false);
    }

    /// @notice Pay `actualCost` to `vendor` and return the unused reservation to the cap.
    function commit(uint256 id, uint256 actualCost, address vendor) external {
        Reservation storage r = reservations[id];
        if (r.status == Status.None) revert UnknownReservation();
        if (r.status != Status.Active) revert NotActive();
        if (block.timestamp >= r.expiry) revert Expired();
        if (msg.sender != r.reserver && msg.sender != owner) revert NotAuthorized();
        if (vendor == address(0)) revert BadAmount();
        if (actualCost > r.amount) revert CostExceedsReservation();

        uint256 refundedToPool = r.amount - actualCost;
        r.status = Status.Settled;
        r.vendor = vendor;
        r.actualCost = actualCost;
        reservedActive -= r.amount;
        spent += actualCost;
        if (actualCost > 0) _push(vendor, actualCost);
        emit Committed(id, vendor, actualCost, refundedToPool);
        _reclaimExpired();
    }

    /// @notice Return a reservation to the cap. After expiry, anyone may call this.
    function release(uint256 id) external {
        Reservation storage r = reservations[id];
        if (r.status != Status.Active) revert NotActive();
        bool expired = block.timestamp >= r.expiry;
        if (!expired && msg.sender != r.reserver && msg.sender != owner) revert NotAuthorized();
        _release(r, id, expired);
        _reclaimExpired();
    }

    /// @notice Settle every expired reservation. A crashed agent cannot hold the cap forever.
    function reclaimExpired() external {
        _reclaimExpired();
    }

    /// @notice Broken path. Pays whatever tokens are not already reserved, and ignores the cap.
    function spendNaive(address agent, uint256 amount, address vendor) external {
        if (agent == address(0) || vendor == address(0) || amount == 0) revert BadAmount();
        _reclaimExpired();
        naiveAttempted += amount;
        uint256 bal = token.balanceOf(address(this));
        uint256 freeTokens = bal > reservedActive ? bal - reservedActive : 0;
        uint256 pay = amount < freeTokens ? amount : freeTokens;
        if (pay > 0) {
            _push(vendor, pay);
            naivePaid += pay;
            spent += pay;
        }
        emit NaiveSpend(agent, vendor, amount, pay);
    }

    /// @notice Pull leftover tokens out and zero the counters. Live reservations must be gone.
    function reset(address to) external {
        if (msg.sender != owner) revert NotAuthorized();
        if (to == address(0)) revert BadAmount();
        _reclaimExpired();
        if (reservedActive != 0) revert ReservedOutstanding();
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) _push(to, bal);
        deposited = 0;
        spent = 0;
        naiveAttempted = 0;
        naivePaid = 0;
        emit Reset(to, bal);
    }

    function _reserve(address agent, uint256 amount, uint256 expiry, bool revertOnRefuse) internal returns (uint256) {
        if (agent == address(0) || amount == 0) revert BadAmount();
        if (expiry <= block.timestamp) revert BadExpiry();
        _reclaimExpired();
        uint256 free = _freeAfterReclaim();
        if (free < amount) {
            if (revertOnRefuse) revert InsufficientAvailable(free, amount);
            emit Refused(msg.sender, agent, amount, free);
            return 0;
        }
        uint256 id = ++nextId;
        reservations[id] = Reservation({
            reserver: msg.sender,
            agent: agent,
            vendor: address(0),
            amount: amount,
            actualCost: 0,
            expiry: expiry,
            status: Status.Active
        });
        reservedActive += amount;
        emit Reserved(id, msg.sender, agent, amount, expiry);
        return id;
    }

    function _freeAfterReclaim() internal view returns (uint256) {
        uint256 used = spent + reservedActive;
        if (used >= cap) return 0;
        return cap - used;
    }

    function _liveReserved() internal view returns (uint256 sum) {
        uint256 n = nextId;
        for (uint256 i = 1; i <= n; i++) {
            Reservation storage r = reservations[i];
            if (r.status == Status.Active && block.timestamp < r.expiry) sum += r.amount;
        }
    }

    function _reclaimExpired() internal {
        uint256 n = nextId;
        for (uint256 i = 1; i <= n; i++) {
            Reservation storage r = reservations[i];
            if (r.status == Status.Active && block.timestamp >= r.expiry) _release(r, i, true);
        }
    }

    function _release(Reservation storage r, uint256 id, bool expired) internal {
        r.status = Status.Released;
        reservedActive -= r.amount;
        emit Released(id, r.agent, r.amount, expired);
    }

    function _pull(address from, uint256 amount) internal {
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
