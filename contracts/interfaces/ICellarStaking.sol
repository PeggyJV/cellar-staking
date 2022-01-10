// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Sommelier Staking Interface
 * @author Kevin Kennis
 *
 * @notice Full documentation in implementation contract.
 */
interface ICellarStaking {
    // ===================== Events =======================

    event Funding(address stakingToken, address distributionToken, uint256 rewardAmount);
    event Stake(address indexed user, uint256 depositId, uint256 amount);
    event Unstake(address indexed user, uint256 depositId, uint256 amount);
    event Claim(address indexed user, uint256 depositId, uint256 amount);
    event EmergencyStop(address owner, bool claimable);

    // ===================== Structs ======================

    enum Lock {
        day,
        week,
        twoWeeks
    }

    struct RewardEpoch {
        uint256 startTimestamp;
        uint256 duration;
        uint256 totalRewards;
        uint256 rewardsEarned;
        uint256 shareSecondsAccumulated;
    }

    struct UserStake {
        uint256 amount;
        uint256 amountWithBoost;
        uint256 shares;
        uint256 shareSecondsAccumulated;
        uint256 totalRewardsEarned;
        uint256 rewardsClaimed;
        uint256 unlockTimestamp;
        uint256 lastAccountingTimestamp;
        Lock lock;
    }

    // ============== Public State Variables ==============

    function stakingToken() external returns (ERC20);

    function distributionToken() external returns (ERC20);

    function minimumDeposit() external returns (uint256);

    function startTimestamp() external returns (uint256);

    function endTimestamp() external returns (uint256);

    function totalDeposits() external returns (uint256);

    function totalDepositsWithBoost() external returns (uint256);

    function totalShares() external returns (uint256);

    function totalShareSeconds() external returns (uint256);

    function rewardsLeft() external returns (uint256);

    function maxNumEpochs() external returns (uint256);

    function paused() external returns (bool);

    function ended() external returns (bool);

    function claimable() external returns (bool);

    // ================ User Functions ================

    function stake(uint256 amount, Lock lock) external;

    function unstake(uint256 depositId, uint256 amount) external returns (uint256 reward);

    function unstakeAll() external returns (uint256[] memory rewards);

    function claim(uint256 depositId) external returns (uint256 reward);

    function claimAll() external returns (uint256[] memory rewards);

    function emergencyUnstake() external;

    function emergencyClaim() external;

    // ================ Admin Functions ================

    function initializePool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external;

    function replenishPool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external;

    function updateMinimumDeposit(uint256 _minimum) external;

    function setPaused(bool _paused) external;

    function emergencyStop(bool makeRewardsClaimable) external;

    // ================ View Functions ================

    function currentEpoch() external view returns (uint256);

    function epochAtTime(uint256 timestamp) external view returns (uint256 epochIdx);

    function totalRewards() external view returns (uint256 amount);

    function getUserStake(address user, uint256 depositId) external returns (UserStake memory);

    function getAllUserStakes(address user) external returns (uint256[] memory);

    function getDepositIdIdx(address user, uint256 depositId) external returns (uint256);

    function getCurrentUserDepositIdx(address user) external returns (uint256);

    function getRewardEpoch(uint256 idx) external returns (RewardEpoch memory);
}
