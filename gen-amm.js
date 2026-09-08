// Build-time: compile the minimal constant-product AMM pair → amm-artifact.json.
const fs = require('fs')
const soljson = require('./soljson.js')

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC20 {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}
// Minimal Uniswap-V2-style constant-product pair for native SRC-20/SRC-20 markets.
// Reserves are the two canonical representations; 0.3% fee; LP shares tracked in-contract.
contract StampyPair {
    address public token0;
    address public token1;
    uint112 private _r0;
    uint112 private _r1;
    uint256 public totalLiquidity;
    mapping(address => uint256) public liquidity;
    uint16 public constant FEE_BPS = 30; // 0.30%
    event Mint(address indexed to, uint256 shares, uint256 a0, uint256 a1);
    event Swap(address indexed to, address tokenIn, uint256 amountIn, uint256 amountOut);
    constructor(address _t0, address _t1) { token0 = _t0; token1 = _t1; }
    function getReserves() external view returns (uint112, uint112) { return (_r0, _r1); }
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } }
        else if (y != 0) { z = 1; }
    }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
    // caller must have approved this pair to pull amt0/amt1 first
    function addLiquidity(uint256 amt0, uint256 amt1, address to) external returns (uint256 shares) {
        require(IERC20(token0).transferFrom(msg.sender, address(this), amt0), "t0");
        require(IERC20(token1).transferFrom(msg.sender, address(this), amt1), "t1");
        if (totalLiquidity == 0) shares = _sqrt(amt0 * amt1);
        else shares = _min(amt0 * totalLiquidity / _r0, amt1 * totalLiquidity / _r1);
        require(shares > 0, "insufficient liquidity minted");
        liquidity[to] += shares; totalLiquidity += shares;
        _r0 += uint112(amt0); _r1 += uint112(amt1);
        emit Mint(to, shares, amt0, amt1);
    }
    // swap exact amountIn of tokenIn for tokenOut (constant product, fee applied)
    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        require(tokenIn == token0 || tokenIn == token1, "bad token");
        bool zeroForOne = tokenIn == token0;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(_r0), uint256(_r1)) : (uint256(_r1), uint256(_r0));
        require(rIn > 0 && rOut > 0, "no liquidity");
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "in");
        uint256 inWithFee = amountIn * (10000 - FEE_BPS) / 10000;
        amountOut = rOut * inWithFee / (rIn + inWithFee);
        require(amountOut >= minOut && amountOut < rOut, "slippage/liquidity");
        address tokenOut = zeroForOne ? token1 : token0;
        require(IERC20(tokenOut).transfer(to, amountOut), "out");
        if (zeroForOne) { _r0 += uint112(amountIn); _r1 -= uint112(amountOut); }
        else { _r1 += uint112(amountIn); _r0 -= uint112(amountOut); }
        emit Swap(to, tokenIn, amountIn, amountOut);
    }
}`

const input = {
  language: 'Solidity',
  sources: { 'StampyPair.sol': { content: SOURCE } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}
const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number'])
const out = JSON.parse(compile(JSON.stringify(input), 0))
if (out.errors) { const fatal = out.errors.filter(e => e.severity === 'error'); out.errors.forEach(e => console.log(e.severity + ':', e.formattedMessage.split('\n')[0])); if (fatal.length) process.exit(1) }
const c = out.contracts['StampyPair.sol'].StampyPair
fs.writeFileSync('amm-artifact.json', JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2))
console.log('wrote amm-artifact.json — bytecode', c.evm.bytecode.object.length / 2, 'bytes, abi', c.abi.length, 'entries')
