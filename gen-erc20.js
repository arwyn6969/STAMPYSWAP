// Build-time: compile the minimal mintable ERC-20 with the standalone soljson compiler,
// save {abi, bytecode} to erc20-artifact.json. Server uses ethers + this artifact (no solc at runtime).
const fs = require('fs')
const soljson = require('./soljson.js')

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// StampySwap canonical representation — minimal ERC-20 with owner-only mint (owner = protocol
// authority; a Safe multisig in production). Decimals set at deploy to match the SRC-20 source.
contract StampyRep {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    address public owner;
    string public srcOrigin; // exact SRC-20 source identity (provenance), immutable-ish record
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    // owner (mint authority) is set explicitly at deploy → the deployer can hand the
    // authority straight to the Emblem-managed vault without ever holding it.
    constructor(string memory _name, string memory _symbol, uint8 _decimals, string memory _srcOrigin, address _owner) {
        name = _name; symbol = _symbol; decimals = _decimals; srcOrigin = _srcOrigin;
        owner = _owner == address(0) ? msg.sender : _owner;
    }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    function transferOwnership(address newOwner) external onlyOwner { owner = newOwner; }
    function mint(address to, uint256 amount) external onlyOwner {
        totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount);
    }
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance"); balanceOf[msg.sender] -= amount; totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; emit Transfer(msg.sender, to, amount); return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount); return true;
    }
}`

const input = {
  language: 'Solidity',
  sources: { 'StampyRep.sol': { content: SOURCE } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}

const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number'])
const out = JSON.parse(compile(JSON.stringify(input), 0))
if (out.errors) {
  const fatal = out.errors.filter(e => e.severity === 'error')
  out.errors.forEach(e => console.log(e.severity + ':', e.formattedMessage.split('\n')[0]))
  if (fatal.length) { console.error('COMPILE FAILED'); process.exit(1) }
}
const c = out.contracts['StampyRep.sol'].StampyRep
fs.writeFileSync('erc20-artifact.json', JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2))
console.log('wrote erc20-artifact.json — bytecode', c.evm.bytecode.object.length / 2, 'bytes, abi', c.abi.length, 'entries')
