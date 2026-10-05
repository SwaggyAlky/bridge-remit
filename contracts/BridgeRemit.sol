// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract ParticipantRegistry {
    address public immutable admin;
    // 0 unregistered, 1 customer, 2 auditor, 3 settlement agent, 4 administrator
    mapping(address => uint8) public roles;
    mapping(address => bool) public approved;
    event Participant(address indexed wallet, uint8 role, bool approved);
    constructor() { admin = msg.sender; roles[msg.sender] = 4; approved[msg.sender] = true; }
    modifier onlyAdmin() { require(msg.sender == admin, "Admin only"); _; }
    function register() external { require(roles[msg.sender] == 0, "Already registered"); roles[msg.sender] = 1; emit Participant(msg.sender, 1, false); }
    function setRole(address who, uint8 role) external onlyAdmin {
        require(who != address(0) && who != admin && role >= 1 && role <= 3, "Invalid role");
        roles[who] = role; emit Participant(who, role, approved[who]);
    }
    function setApproval(address who, bool value) external onlyAdmin {
        require(roles[who] != 0 && who != admin, "Invalid participant"); approved[who] = value;
        emit Participant(who, roles[who], value);
    }
    function customer(address who) external view returns(bool) { return roles[who] == 1 && approved[who]; }
}

// Test asset only. No backing, redemption, or real USDC integration is claimed.
contract DemoUSD {
    string public constant name = "BridgeRemit Test Dollar";
    string public constant symbol = "dUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucet;
    ParticipantRegistry public immutable registry;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(ParticipantRegistry r) { registry = r; }
    function faucet() external {
        require(registry.customer(msg.sender), "Approved customer only");
        require(block.timestamp >= lastFaucet[msg.sender] + 1 days, "Faucet cooldown");
        lastFaucet[msg.sender] = block.timestamp; uint256 n = 10000 * 1e6;
        balanceOf[msg.sender] += n; totalSupply += n; emit Transfer(address(0), msg.sender, n);
    }
    function approve(address spender, uint256 n) external returns(bool) { allowance[msg.sender][spender] = n; emit Approval(msg.sender, spender, n); return true; }
    function transfer(address to, uint256 n) external returns(bool) { _transfer(msg.sender, to, n); return true; }
    function transferFrom(address from, address to, uint256 n) external returns(bool) {
        require(allowance[from][msg.sender] >= n, "Allowance"); allowance[from][msg.sender] -= n;
        emit Approval(from, msg.sender, allowance[from][msg.sender]); _transfer(from, to, n); return true;
    }
    function _transfer(address from, address to, uint256 n) internal {
        require(to != address(0) && balanceOf[from] >= n, "Balance or recipient");
        balanceOf[from] -= n; balanceOf[to] += n; emit Transfer(from, to, n);
    }
}

contract CorridorBook {
    struct Corridor { uint256 rate; uint16 feeBps; bool active; }
    ParticipantRegistry public immutable registry;
    mapping(bytes32 => Corridor) public corridors;
    event CorridorUpdated(bytes32 indexed id, uint256 rate, uint16 feeBps, bool active);
    constructor(ParticipantRegistry r) { registry = r; }
    function setCorridor(bytes32 id, uint256 rate, uint16 feeBps, bool active) external {
        require(msg.sender == registry.admin(), "Admin only");
        require(id != bytes32(0) && rate > 0 && rate <= 1e12 && feeBps <= 500, "Invalid corridor");
        corridors[id] = Corridor(rate, feeBps, active); emit CorridorUpdated(id, rate, feeBps, active);
    }
    function quote(bytes32 id, uint256 n) public view returns(uint256 fee, uint256 destination, uint256 rate) {
        Corridor memory c = corridors[id]; require(c.active, "Inactive corridor");
        fee = n * c.feeBps / 10000; rate = c.rate; destination = (n - fee) * rate / 1e6;
    }
}

contract RemittanceEscrow {
    enum Status { Pending, Completed, Cancelled, Refunded, Disputed }
    struct Remittance {
        address sender; address recipient; uint256 amount; uint256 fee; uint256 destination;
        uint256 rate; bytes32 corridor; bytes32 referenceHash; uint64 deadline; Status status; bytes32 attestation;
    }
    ParticipantRegistry public immutable registry;
    DemoUSD public immutable token;
    CorridorBook public immutable book;
    bool public paused;
    uint256 public nextId = 1;
    uint256 public earnedFees;
    mapping(uint256 => Remittance) public remittances;
    mapping(address => mapping(bytes32 => bool)) public usedReferences;
    event Action(uint256 indexed id, address indexed actor, string action, uint256 amount);
    event Paused(bool value);
    constructor(ParticipantRegistry r, DemoUSD t, CorridorBook b) { registry = r; token = t; book = b; }
    modifier onlyAdmin() { require(msg.sender == registry.admin(), "Admin only"); _; }
    function create(address to, uint256 amount, bytes32 corridor, bytes32 refHash, uint64 deadline, uint256 minimumDestination, uint256 maximumFee) external returns(uint256) {
        return _create(to, amount, corridor, refHash, deadline, minimumDestination, maximumFee);
    }
    function batchCreate(address[] calldata to, uint256[] calldata amounts, bytes32 corridor, bytes32[] calldata refs, uint64 deadline, uint256[] calldata minimums, uint256[] calldata maximumFees) external {
        uint256 n = to.length; require(n > 0 && n <= 20 && n == amounts.length && n == refs.length && n == minimums.length && n == maximumFees.length, "Invalid batch");
        for(uint256 i; i < n; ++i) _create(to[i], amounts[i], corridor, refs[i], deadline, minimums[i], maximumFees[i]);
    }
    function _create(address to, uint256 amount, bytes32 corridor, bytes32 refHash, uint64 deadline, uint256 minimumDestination, uint256 maximumFee) internal returns(uint256 id) {
        require(!paused, "Paused"); require(registry.customer(msg.sender) && registry.customer(to), "Approved customers only");
        require(to != msg.sender && amount >= 1e6 && amount <= 100000 * 1e6, "Recipient or amount");
        require(deadline >= block.timestamp + 5 minutes && deadline <= block.timestamp + 30 days, "Deadline");
        require(refHash != bytes32(0) && !usedReferences[msg.sender][refHash], "Duplicate reference");
        (uint256 fee, uint256 destination, uint256 rate) = book.quote(corridor, amount);
        require(destination >= minimumDestination && fee <= maximumFee, "Quote changed");
        usedReferences[msg.sender][refHash] = true; id = nextId++;
        remittances[id] = Remittance(msg.sender, to, amount, fee, destination, rate, corridor, refHash, deadline, Status.Pending, bytes32(0));
        require(token.transferFrom(msg.sender, address(this), amount), "Deposit failed"); emit Action(id, msg.sender, "Created", amount);
    }
    function claim(uint256 id) external {
        Remittance storage r = remittances[id]; require(r.recipient == msg.sender && r.status == Status.Pending && block.timestamp < r.deadline, "Not claimable");
        _complete(id, r);
    }
    function cancel(uint256 id) external {
        Remittance storage r = remittances[id]; require(r.sender == msg.sender && r.status == Status.Pending, "Not cancellable");
        r.status = Status.Cancelled; require(token.transfer(r.sender, r.amount)); emit Action(id, msg.sender, "Cancelled", r.amount);
    }
    function refundExpired(uint256 id) external {
        Remittance storage r = remittances[id]; require(r.sender == msg.sender && r.status == Status.Pending && block.timestamp >= r.deadline, "Not expired");
        r.status = Status.Refunded; require(token.transfer(r.sender, r.amount)); emit Action(id, msg.sender, "ExpiredRefund", r.amount);
    }
    function dispute(uint256 id) external {
        Remittance storage r = remittances[id]; require((r.sender == msg.sender || r.recipient == msg.sender) && r.status == Status.Pending && block.timestamp < r.deadline, "Not disputable");
        r.status = Status.Disputed; emit Action(id, msg.sender, "Disputed", r.amount);
    }
    // An administrator decides disputes: a documented central trust assumption.
    function resolve(uint256 id, bool release) external onlyAdmin {
        Remittance storage r = remittances[id]; require(r.status == Status.Disputed, "No dispute");
        if(release) _complete(id, r); else { r.status = Status.Refunded; require(token.transfer(r.sender, r.amount)); emit Action(id, msg.sender, "DisputeRefund", r.amount); }
    }
    // A hash recorded by a settlement agent is an attestation, not bank payment proof.
    function attest(uint256 id, bytes32 receiptHash) external {
        require(registry.roles(msg.sender) == 3 && registry.approved(msg.sender), "Agent only");
        Remittance storage r = remittances[id]; require(r.sender != address(0) && r.status == Status.Completed && r.attestation == bytes32(0) && receiptHash != bytes32(0), "Invalid attestation");
        r.attestation = receiptHash; emit Action(id, msg.sender, "Attested", r.amount);
    }
    function setPaused(bool value) external onlyAdmin { paused = value; emit Paused(value); }
    function withdrawFees() external onlyAdmin { uint256 n = earnedFees; require(n > 0, "No fees"); earnedFees = 0; require(token.transfer(msg.sender, n)); emit Action(0, msg.sender, "FeesWithdrawn", n); }
    function _complete(uint256 id, Remittance storage r) internal {
        r.status = Status.Completed; earnedFees += r.fee; require(token.transfer(r.recipient, r.amount - r.fee));
        emit Action(id, msg.sender, "Completed", r.amount - r.fee);
    }
}
