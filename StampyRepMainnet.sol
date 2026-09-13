// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Mainnet-grade representation token: OpenZeppelin's audited ERC20 + Ownable.
// owner (the vault authority) is the only minter. Provenance is recorded in srcOrigin.
// Drop-in compatible with evm-mint's deploy flow: constructor(name, symbol, decimals, srcOrigin, owner),
// mint(to, amount) [onlyOwner], owner(), transferOwnership(newOwner), standard Transfer events.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract StampyRep is ERC20, Ownable {
    uint8 private immutable _decimals;
    string public srcOrigin; // e.g. "bitcoin:acme:TREES"

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory srcOrigin_,
        address owner_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        srcOrigin = srcOrigin_;
        _transferOwnership(owner_); // set the vault as owner/minter at construction
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // Only the owner (vault authority) can mint — deposit-gated + solvency-enforced off-chain.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Holders can burn their own tokens (used for redeem / cross-chain move — emits Transfer→0x0).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
