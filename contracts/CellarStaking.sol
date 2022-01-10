// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Staking approach:
 * 1) The pool has a distribution token that is funded up-front
 * 2) Over time, rewards from that distribution token will be emitted
 *      - Either amount to be distributed _per time period (e.g. month)_ or an end date
 * 3) Users can deposit and their tokens are accounted for
 * 4) If users lock, their deposit "account" is boosted by a multiplier
 * 5) To calculate user rewards:
 * 6) Calculate the time user has been staking and since they have last claimed rewards
 * 7) Over time window, calculate total coins available for emissions (based on 2)
 * 8) Over time window, calculate user's total share of all deposits
 * 9) Multiply 7 by 8 to get amount of tokens user should be rewarded
 *
 * To do this, we need to track:
 * 1) User's base deposit and boosted deposit amount
 * 2) Emission schedule for the token (rewards per epoch, number of epochs)
 * 3) All deposits over given time frame
 * 4) Recalculate reward per share on every deposit/withdrawal
 */

contract CellarStaking is Ownable {
    using SafeERC20 for ERC20;

    event Funding(address stakingToken, address distributionToken, uint256 rewardAmount);
    event Stake(address indexed user, uint256 depositId, uint256 amount);
    event Unstake(address indexed user, uint256 depositId, uint256 amount);
    event Claim(address indexed user, uint256 depositId, uint256 amount);
    event EmergencyStop(address owner, bool claimable);

    // ============================================ STATE ==============================================

    // ============== Constants ==============

    uint256 public constant ONE = 1e18;
    uint256 public constant ONE_DAY = 60 * 60 * 24;
    uint256 public constant ONE_WEEK = ONE_DAY * 7;
    uint256 public constant TWO_WEEKS = ONE_WEEK * 2;
    uint256 public constant MAX_UINT = 2**256 - 1;

    enum Lock {
        day,
        week,
        twoWeeks
    }

    // ============ Global State =============

    ERC20 public immutable stakingToken;
    ERC20 public immutable distributionToken;

    uint256 public minimumDeposit = 0;
    uint256 public startTimestamp;
    uint256 public totalDeposits;
    uint256 public totalDepositsWithBoost;
    uint256 public totalShares;
    uint256 public totalShareSeconds;
    uint256 public rewardsLeft;

    uint256 private lastAccountingTimestamp = block.timestamp;
    uint256 private immutable initialSharesPerToken = 1;

    struct RewardEpoch {
        uint256 startTimestamp;
        uint256 duration;
        uint256 totalRewards;
        uint256 rewardsEarned;
        uint256 shareSecondsAccumulated;
    }

    RewardEpoch[] public rewardEpochs;
    uint256 public immutable maxNumEpochs;

    bool public paused;
    bool public ended;
    bool public claimable;

    // ============= User State ==============

    struct UserStake {
        uint256 amount;
        uint256 amountWithBoost;
        uint256 shares;
        uint256 shareSecondsAccumulated;
        /// @notice epochIndex => rewards
        mapping(uint256 => uint256) rewardsEarnedByEpoch;
        uint256 totalRewardsEarned;
        uint256 rewardsClaimed;
        uint256 unlockTimestamp;
        uint256 lastAccountingTimestamp;
        Lock lock;
    }

    /// @notice user => depositId => UserInfo
    mapping(address => mapping(uint256 => UserStake)) public stakes;
    /// @notice user => depositId[]
    mapping(address => uint256[]) public allUserStakes;
    /// @notice user => depositId => index in allUserStakes
    mapping(address => mapping(uint256 => uint256)) public depositIdIdx;
    /// @notice user => current index of user deposit array
    mapping(address => uint256) public currentUserDepositIdx;

    // ========================================== CONSTRUCTOR ===========================================

    constructor(
        ERC20 _stakingToken,
        ERC20 _distributionToken,
        uint256 _maxNumEpochs
    ) {
        stakingToken = _stakingToken;
        distributionToken = _distributionToken;
        maxNumEpochs = _maxNumEpochs;
    }

    // ======================================= STAKING OPERATIONS =======================================

    function stake(uint256 amount, Lock lock)
        external
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
    {
        require(startTimestamp > 0, "STATE: not initialized");
        require(amount > minimumDeposit, "USR: must stake more than minimum");
        require(rewardsLeft > 0, "STATE: no rewards left");

        // Record deposit
        uint256 depositId = currentUserDepositIdx[msg.sender]++;
        depositIdIdx[msg.sender][depositId] = allUserStakes[msg.sender].length;
        allUserStakes[msg.sender].push(depositId);
        UserStake storage s = stakes[msg.sender][depositId];

        // Do share accounting and populate user stake information
        (uint256 boost, uint256 lockDuration) = _getBoost(lock);
        uint256 amountWithBoost = amount + (amount * boost) / ONE;

        uint256 newShares = totalShares > 0
            ? (totalShares * amountWithBoost) / totalDepositsWithBoost
            : amountWithBoost * initialSharesPerToken;
        require(newShares > 0, "USR: stake too small");

        s.amount = amount;
        s.amountWithBoost = amountWithBoost;
        s.shares = newShares;
        s.shareSecondsAccumulated = 0;
        s.totalRewardsEarned = 0;
        s.rewardsClaimed = 0;
        s.unlockTimestamp = block.timestamp + lockDuration;
        s.lastAccountingTimestamp = block.timestamp;
        s.lock = lock;

        // Update global state
        totalDeposits += amount;
        totalDepositsWithBoost += amountWithBoost;
        totalShares += newShares;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Stake(msg.sender, depositId, amount);
    }

    function unstake(uint256 depositId, uint256 amount)
        external
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256 reward)
    {
        require(startTimestamp > 0, "STATE: not initialized");
        require(amount > 0, "USR: must unstake more than 0");

        return _unstake(depositId, amount);
    }

    function unstakeAll()
        external
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256[] memory rewards)
    {
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            rewards[i] = _unstake(depositIds[i], MAX_UINT);
        }
    }

    function _unstake(uint256 depositId, uint256 amount) internal returns (uint256 reward) {
        // Fetch stake and make sure it is withdrawable
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        require(depositAmount > 0, "USR: invalid depositId");

        require(block.timestamp >= s.unlockTimestamp, "USR: stake still locked");

        // Start unstaking

        // Can pass MAX_UINT to make sure all is unstaked
        if (amount > depositAmount) {
            amount = depositAmount;
        }

        (uint256 boost, ) = _getBoost(s.lock);
        uint256 amountWithBoost = amount + (amount * boost) / ONE;
        uint256 sharesToBurn = (totalShares * amountWithBoost) / totalDepositsWithBoost;

        require(sharesToBurn > 0, "USR: unstake amount too small");
        require(sharesToBurn <= s.shares, "ACCT: attempted to burn too many shares for stake");

        s.shares -= sharesToBurn;

        // Update global state
        totalDeposits -= amount;
        totalDepositsWithBoost -= amountWithBoost;
        totalShares -= sharesToBurn;

        // Distribute stake
        stakingToken.safeTransfer(msg.sender, amount);

        // Distribute rewards via claim
        reward = _claim(depositId);

        // Do final accounting check
        _checkSupplyAccounting();

        emit Unstake(msg.sender, depositId, amount);
    }

    function claim(uint256 depositId)
        external
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256 reward)
    {
        require(startTimestamp > 0, "STATE: not initialized");
        return _claim(depositId);
    }

    function claimAll()
        external
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256[] memory rewards)
    {
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            rewards[i] = _claim(depositIds[i]);
        }
    }

    function _claim(uint256 depositId) internal returns (uint256 reward) {
        // Fetch stake and make sure it is valid
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        require(depositAmount > 0, "USR: invalid depositId");

        reward = s.totalRewardsEarned - s.rewardsClaimed;
        s.rewardsClaimed += reward;

        // Distribute reward
        distributionToken.safeTransfer(msg.sender, reward);

        emit Claim(msg.sender, depositId, reward);
    }

    function emergencyUnstake() external {
        require(ended, "STATE: staking program active");

        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];
            stakingToken.transfer(msg.sender, s.amount);
            s.amount = 0;
        }
    }

    function emergencyClaim() external {
        require(ended && claimable, "STATE: Tokens not claimable");

        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];
            uint256 reward = s.totalRewardsEarned - s.rewardsClaimed;

            distributionToken.safeTransfer(msg.sender, reward);

            s.totalRewardsEarned = 0;
        }
    }

    // ======================================== ADMIN OPERATIONS ========================================

    function initializePool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external whenNotPaused onlyOwner {
        require(startTimestamp == 0, "STATE: already initialized");
        require(_numEpochs > 0, "USR: at least one epoch required");
        require(_numEpochs <= maxNumEpochs, "USR: too many epochs");
        require(_epochLength > 0, "USR: epoch length must be non-zero");
        require(_rewardsPerEpoch > 0, "USR: rewards per epoch must be non-zero");

        // Mark starting point for rewards accounting
        startTimestamp = block.timestamp;
        uint256 currentTimestamp = startTimestamp;

        // Create new epochs
        for (uint256 i = 0; i < _numEpochs; i++) {
            rewardEpochs.push(RewardEpoch(currentTimestamp, _epochLength, _rewardsPerEpoch, 0, 0));
            currentTimestamp += _epochLength;
        }

        // Fund reward pool from owner
        uint256 rewardAmount = _rewardsPerEpoch * _numEpochs;
        distributionToken.safeTransferFrom(msg.sender, address(this), rewardAmount);

        emit Funding(address(stakingToken), address(distributionToken), rewardAmount);
    }

    function replenishPool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external whenNotPaused onlyOwner {
        require(startTimestamp > 0, "STATE: not initialized");
        require(_numEpochs > 0, "USR: at least one epoch required");
        require(rewardEpochs.length + _numEpochs <= maxNumEpochs, "USR: too many epochs");
        require(_epochLength > 0, "USR: epoch length must be non-zero");
        require(_rewardsPerEpoch > 0, "USR: rewards per epoch must be non-zero");

        RewardEpoch memory lastEpoch = rewardEpochs[rewardEpochs.length - 1];
        require(lastEpoch.startTimestamp > 0, "ACCT: could not find last epoch");

        uint256 currentTimestamp = lastEpoch.startTimestamp + lastEpoch.duration;

        // Create new epochs
        for (uint256 i = 0; i < _numEpochs; i++) {
            rewardEpochs.push(RewardEpoch(currentTimestamp, _epochLength, _rewardsPerEpoch, 0, 0));
            currentTimestamp += _epochLength;
        }

        // Fund reward pool from owner
        uint256 rewardAmount = _rewardsPerEpoch * _numEpochs;
        distributionToken.safeTransferFrom(msg.sender, address(this), rewardAmount);

        emit Funding(address(stakingToken), address(distributionToken), rewardAmount);
    }

    function updateMinimumDeposit(uint256 _minimum) external onlyOwner {
        minimumDeposit = _minimum;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function emergencyStop(bool makeRewardsClaimable) external onlyOwner {
        ended = true;
        claimable = makeRewardsClaimable;

        if (!claimable) {
            // Send distribution token back to owner
            distributionToken.transfer(msg.sender, distributionToken.balanceOf(address(this)));
        }

        emit EmergencyStop(msg.sender, makeRewardsClaimable);
    }

    // ======================================= STATE INFORMATION =======================================

    function currentEpoch() public view returns (uint256) {
        return epochAtTime(block.timestamp);
    }

    function epochAtTime(uint256 timestamp) public view returns (uint256 epochIdx) {
        // Return current epoch index
        uint256 timeElapsed = timestamp - startTimestamp;

        epochIdx = 0;
        while (timeElapsed > 0) {
            // Advance one epoch
            RewardEpoch memory e = rewardEpochs[epochIdx];

            // Decrement duration of epoch
            if (e.duration >= timeElapsed) {
                timeElapsed = 0;
            } else {
                timeElapsed -= e.duration;
                epochIdx++;
            }
        }
    }

    function totalRewards() public view returns (uint256 amount) {
        amount = 0;

        for (uint256 i = 0; i < rewardEpochs.length; i++) {
            amount += rewardEpochs[i].totalRewards;
        }
    }

    // ============================================ HELPERS ============================================

    modifier checkSupplyAccounting() {
        _checkSupplyAccounting();

        _;
    }

    modifier updateTotalRewardAccounting() {
        // In time since last checked we need to figure out for each epoch:
        // Total seconds elapsed in epoch (either partial or full)
        // Total share-seconds accumulated (i.e. one share deposited for one second)
        // Share-seconds accumulated for user
        // Total user percentage of all share-seconds accumulated
        // Total reward (user percentage of total available rewards per epoch)
        // Assumes all epochs distribute rewards linearly.

        uint256 epochNow = currentEpoch();
        uint256 epochAtLastAccounting = epochAtTime(lastAccountingTimestamp);

        // For each epoch in window, calculate rewards
        for (uint256 i = epochAtLastAccounting; i <= epochNow; i++) {
            _calculateTotalRewardsForEpoch(rewardEpochs[i]);
        }

        lastAccountingTimestamp = block.timestamp;

        _;
    }

    modifier updateUserRewardAccounting(address user) {
        // Similar to total reward accounting, but must be done for each user stake
        uint256[] memory userStakes = allUserStakes[user];

        for (uint256 i = 0; i < userStakes.length; i++) {
            // Get stake info based on depositId
            UserStake storage s = stakes[user][userStakes[i]];

            // If shares are 0, stake is no longer relevant - it has been unstaked
            if (s.shares > 0) {
                // Calculate time passed since stake was last accounted for
                uint256 epochNow = currentEpoch();
                uint256 epochAtLastAccounting = epochAtTime(s.lastAccountingTimestamp);
                uint256 totalRewardsEarned = 0;

                // For each epoch in window, calculate rewards
                for (uint256 j = epochAtLastAccounting; j <= epochNow; i++) {
                    totalRewardsEarned += _calculateStakeRewardsForEpoch(i, s);
                }

                s.lastAccountingTimestamp = block.timestamp;
            }
        }

        _;
    }

    modifier updateRewardsLeft() {
        uint256 amount = 0;

        for (uint256 i = 0; i < rewardEpochs.length; i++) {
            RewardEpoch memory e = rewardEpochs[i];
            amount += e.totalRewards - e.rewardsEarned;
        }

        rewardsLeft = amount;

        _;
    }

    modifier whenNotPaused() {
        require(!paused, "STATE: Contract paused");
        require(!ended, "STATE: Emergency killswitch activated. Contract will not restart");
        _;
    }

    function _calculateTotalRewardsForEpoch(RewardEpoch storage epoch) internal {
        // If we have already done some accounting for this epoch, don't re-calculate
        uint256 accountingStartTime = lastAccountingTimestamp > epoch.startTimestamp
            ? lastAccountingTimestamp
            : epoch.startTimestamp;

        // If we have not reached end of epoch, then only consider partial epoch
        uint256 epochEndTimestamp = epoch.startTimestamp + epoch.duration;
        uint256 accountingEndTime = block.timestamp > epochEndTimestamp ? epochEndTimestamp : block.timestamp;

        uint256 timeElapsed = accountingEndTime - accountingStartTime;

        // Calculate rewards based on time elapsed in epoch
        uint256 epochRewardsPerSecond = epoch.totalRewards / epoch.duration;
        uint256 rewardsForTime = epochRewardsPerSecond * timeElapsed;

        epoch.rewardsEarned += rewardsForTime;

        // If we are completing an epoch, check our accounting. Rewards earned
        // must equal total rewards
        if (block.timestamp > epochEndTimestamp) {
            require(epoch.rewardsEarned == epoch.totalRewards, "ACCT: unaccumulated rewards in past epoch");
        }

        // Figure out total share-seconds accumulated
        uint256 shareSecondsAcc = timeElapsed * totalShares;
        totalShareSeconds += shareSecondsAcc;
        epoch.shareSecondsAccumulated += shareSecondsAcc;
    }

    function _calculateStakeRewardsForEpoch(uint256 epochIdx, UserStake storage s) internal returns (uint256) {
        RewardEpoch memory epoch = rewardEpochs[epochIdx];

        // If we have already done some accounting for this epoch, don't re-calculate
        uint256 epochStart = s.lastAccountingTimestamp > epoch.startTimestamp
            ? s.lastAccountingTimestamp
            : epoch.startTimestamp;

        // If we have not reached epochEnd, then only consider partial epoch
        uint256 epochEnd = epochStart + epoch.duration;
        if (block.timestamp < epochEnd) {
            epochEnd = block.timestamp;
        }

        uint256 timeElapsed = epochEnd - epochStart;

        // Figure out total share-seconds accumulated
        uint256 stakeShareSecondsAcc = timeElapsed * s.shares;
        s.shareSecondsAccumulated += stakeShareSecondsAcc;

        // Give user new rewards based on share of total share seconds in epoch
        uint256 rewardsEarnedForEpoch = epoch.rewardsEarned *
            (s.shareSecondsAccumulated / epoch.shareSecondsAccumulated);

        // Overwrite. not increment, the rewards for the epoch. Previous line
        // always calculates the total epoch rewards
        s.rewardsEarnedByEpoch[epochIdx] = rewardsEarnedForEpoch;

        return rewardsEarnedForEpoch;
    }

    function _checkSupplyAccounting() internal view {
        uint256 tokenBalance = distributionToken.balanceOf(address(this));

        // If staking token is same as distribution token, remove deposits
        if (address(stakingToken) == address(distributionToken)) {
            tokenBalance -= totalDeposits;
        }

        require(tokenBalance >= rewardsLeft, "ACCT: cannot fund scheduled rewards");

        // Check that both shared and staked line up
        require(totalShares == 0 || totalDeposits > 0, "ACCT: shares exist without deposits");
    }

    function _getBoost(Lock _lock) public pure returns (uint256 boost, uint256 timelock) {
        if (_lock == Lock.day) {
            // 5%
            return (1e17, ONE_DAY);
        } else if (_lock == Lock.week) {
            // 40%
            return (4e17, ONE_WEEK);
        } else if (_lock == Lock.twoWeeks) {
            // 100%
            return (1e18, TWO_WEEKS);
        } else {
            revert("Invalid lock value");
        }
    }
}
