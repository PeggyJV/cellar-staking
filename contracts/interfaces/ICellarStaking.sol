// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Cellar Staking Interface
 * @dev Based on https://github.com/ethereum/EIPs/blob/master/EIPS/eip-900.md
 *
 */
interface ICellarStaking {
    event Staked(address indexed user, uint256 amount, uint256 total, bytes data);
    event Unstaked(address indexed user, uint256 amount, uint256 total, bytes data);

    /**
     * @dev Transfers amount of deposit tokens from the user.
     * @param amount Number of deposit tokens to stake.
     * @param data Not used.
     */
    function stake(uint256 amount, bytes calldata data) external;

    function stakeFor(
        address user,
        uint256 amount,
        bytes calldata data
    ) external;

    function unstake(uint256 amount, bytes calldata data) external;

    function totalStakedFor(address addr) external view returns (uint256);

    function totalStaked() external view returns (uint256);

    function token() external view returns (address);

    function supportsHistory() external pure returns (bool);
}
