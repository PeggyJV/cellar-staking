// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./Errors.sol";
import "./interfaces/ICellarStaking.sol";

/**
 * @title Sommelier Staking
 * @author Kevin Kennis
 *
 * Staking for Sommelier Cellars.
 *
 * This contract is inspired by the Synthetix staking rewards contract, Ampleforth's
 * token geyser, and Treasure DAO's MAGIC mine. However, there are unique improvements
 * and new features, specifically the epoch design. The reward epoch design allows
 * for flexible definition of multi-step staking programs, such as designs where
 * rewards 'halve' every certain number of epochs.
 *
 * *********************************** Funding Flow ***********************************
 *
 * 1) The contract owner calls 'initializePool' to specify an initial schedule of reward
 *    epochs. The contract collects the distribution token from the owner to fund the
 *    specified reward schedule.
 * 2) At a future time, the contract owner may call 'replenishPool' to extend the staking
 *    program with new reward epochs. These new epochs may distribute more or less
 *    rewards than previous epochs.
 *
 * ********************************* Staking Lifecycle ********************************
 *
 * 1) A user may deposit a certain amount of tokens to stake, and is required to lock
 *    those tokens for a specified amount of time. There are three locking options:
 *    one day, one week, or one month. Longer locking times receive larger 'boosts',
 *    that the deposit will receive a larger proportional amount of shares. A user
 *    may not unstake until the amount of time defined by the lock has elapsed.
 * 2) Once the lock has elapsed, a user may unstake their deposit, either partially
 *    or in full. The user will continue to receive the same 'boosted' amount of rewards
 *    until they unstake. The user may unstake all of their deposits at once, as long
 *    as all of the lock times have elapsed. When unstaking, the user will also receive
 *    all eligible rewards for all deposited stakes, which accumulate linearly.
 * 3) At any time, a user may claim their available rewards for their deposits. Rewards
 *    accumulate linearly and can be claimed at any time, whether or not the lock has
 *    for a given deposit has expired. The user can claim rewards for a specific deposit,
 *    or may choose to collect all eligible rewards at once.
 *
 * ************************************ Accounting ************************************
 *
 * The contract uses an accounting mechanism based on the 'share-seconds' model,
 * originated by the Ampleforth token geyser. First, token deposits are accounted
 * for as staking shares, which represent a proportional interest in total deposits,
 * and acount for the 'boost' defined by locks.
 *
 * At each accounting checkpoint, every active share will accumulate 'share-seconds',
 * which is the number of seconds a given share has been deposited into the staking
 * program. Every reward epoch will accumulate share-seconds based on how many shares
 * were deposited and when they were deposited. The following example applies to
 * a given epoch of 100 seconds:
 *
 * a) User 1 deposits 50 shares before the epoch begins
 * b) User 2 deposits 20 shares at second 20 of the epoch
 * c) User 3 deposits 100 shares at second 50 of the epoch
 *
 * In this case,
 *
 * a) User 1 will accumulate 5000 share-seconds (50 shares * 100 seconds)
 * b) User 2 will accumulate 3200 share-seconds (20 shares * 80 seconds)
 * c) User 3 will accumulate 5000 share-seconds (100 shares * 50 seconds)
 *
 * So the total accumulated share-seconds will be 5000 + 3200 + 5000 = 13200.
 * Then, each user will receive rewards proportional to the total from the
 * predefined reward pool for the epoch. In this scenario, User 1 and User 3
 * will receive approximately 37.88% of the total rewards, and User 2 will
 * receive approximately 24.24% of the total rewards.
 *
 * Depending on deposit times, this accumulation may take place over multiple
 * epochs, and the total rewards earned is simply the sum of rewards earned for
 * each epoch. A user may also have multiple discrete deposits, which are all
 * accounted for separately due to timelocks and locking boosts. Therefore,
 * a user's total earned rewards are a function of their rewards across
 * the proportional share-seconds accumulated for each staking epoch, across
 * all epochs for which all user stakes were deposited.
 *
 * Reward accounting takes place before every operation which may change
 * accounting calculations (minting of new shares on staking, burning of
 * shares on unstaking, or claiming, which decrements eligible rewards).
 * This is gas-intensive but unavoidable, since retroactive accounting
 * based on previous proportionate shares would require a prohibitive
 * amount of storage of historical state. On every accounting run, there
 * are a number of safety checks to ensure that all reward tokens are
 * accounted for and that no accounting time periods have been missed.
 *
 *
 */
contract CellarStaking is ICellarStaking, Ownable {
    using SafeERC20 for ERC20;

    // ============================================ STATE ==============================================

    // ============== Constants ==============

    uint256 public constant ONE = 1e18;
    uint256 public constant ONE_DAY = 60 * 60 * 24;
    uint256 public constant ONE_WEEK = ONE_DAY * 7;
    uint256 public constant TWO_WEEKS = ONE_WEEK * 2;
    uint256 public constant MAX_UINT = 2**256 - 1;

    uint256 public constant ONE_DAY_BOOST = 1e17; // 10% boost
    uint256 public constant ONE_WEEK_BOOST = 4e17; // 40% boost
    uint256 public constant TWO_WEEKS_BOOST = 1e18; // 100% boost

    // ============ Global State =============

    ERC20 public immutable override stakingToken;
    ERC20 public immutable override distributionToken;

    uint256 public override minimumDeposit = 0;
    uint256 public override startTimestamp;
    uint256 public override endTimestamp;
    uint256 public override totalDeposits;
    uint256 public override totalDepositsWithBoost;
    uint256 public override totalShares;
    uint256 public override totalShareSeconds;
    uint256 public override rewardsLeft;

    uint256 private lastAccountingTimestamp = block.timestamp;
    uint256 private immutable initialSharesPerToken = 1;

    RewardEpoch[] public rewardEpochs;

    /// @dev Limiting the maximum number of reward epochs protects against
    ///      issues with the block gas limit.
    uint256 public immutable override maxNumEpochs;

    /// @notice Emergency states in case of contract malfunction.
    bool public override paused;
    bool public override ended;
    bool public override claimable;

    // ============= User State ==============

    /// @notice user => depositId => UserInfo
    mapping(address => mapping(uint256 => UserStake)) public stakes;
    /// @notice user => depositId[]
    mapping(address => uint256[]) public allUserStakes;
    /// @notice user => depositId => index in allUserStakes
    mapping(address => mapping(uint256 => uint256)) public depositIdIdx;
    /// @notice user => current index of user deposit array
    mapping(address => uint256) public currentUserDepositIdx;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @param _owner                The owner of the staking contract - will immediately receive ownership.
     * @param _stakingToken         The token users will deposit in order to stake.
     * @param _distributionToken    The token the staking contract will distribute as rewards.
     * @param _maxNumEpochs         The maximum number of reward epochs that can ever be scheduled.
     */
    constructor(
        address _owner,
        ERC20 _stakingToken,
        ERC20 _distributionToken,
        uint256 _maxNumEpochs
    ) {
        stakingToken = _stakingToken;
        distributionToken = _distributionToken;
        maxNumEpochs = _maxNumEpochs;
        paused = true;

        transferOwnership(_owner);
    }

    // ======================================= STAKING OPERATIONS =======================================

    /**
     * @notice  Make a new deposit into the staking contract. Longer locks receive reward boosts.
     * @dev     Specified amount of stakingToken must be approved for withdrawal by the caller.
     * @dev     Valid lock values are 0 (one day), 1 (one week), and 2 (two weeks).
     *
     * @param amount                The amount of the stakingToken to stake.
     * @param lock                  The amount of time to lock stake for.
     */
    function stake(uint256 amount, Lock lock)
        external
        override
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
    {
        if (amount < minimumDeposit) revert USR_MinimumDeposit(amount, minimumDeposit);
        if (rewardsLeft == 0) revert STATE_NoRewardsLeft();

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

        if (newShares == 0) revert USR_StakeTooSmall(amount);

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

    /**
     * @notice  Unstake a specified amount from a certain deposited stake.
     * @dev     The lock time for the specified deposit must have elapsed.
     * @dev     Unstaking automatically claims available rewards for the deopsit.
     *
     * @param depositId             The specified deposit to unstake from.
     * @param amount                The amount of the stakingToken to withdraw and return to the caller.
     *
     * @return reward               The amount of accumulated rewards since the last reward claim.
     */
    function unstake(uint256 depositId, uint256 amount)
        external
        override
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256 reward)
    {
        if (amount == 0) revert USR_ZeroUnstake();

        return _unstake(depositId, amount);
    }

    /**
     * @notice  Unstake all user deposits.
     * @dev     The lock times for the all user deposits must have elapsed.
     * @dev     Unstaking automatically claims all available rewards.
     *
     * @return rewards              The amount of accumulated rewards since the last reward claim.
     */
    function unstakeAll()
        external
        override
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256[] memory rewards)
    {
        // Individually unstake each deposit
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            rewards[i] = _unstake(depositIds[i], MAX_UINT);
        }
    }

    /**
     * @dev     Contains all logic for processing an unstake operation.
     *          For the given deposit, does share accounting and burns
     *          shares, returns staking tokens to the original owner,
     *          updates global deposit and share trackers, and claims
     *          rewards for the given deposit.
     *
     * @param depositId             The specified deposit to unstake from.
     * @param amount                The amount of the stakingToken to withdraw and return to the caller.
     *                              If an amount larger than the deposit amount is specified, return
     *                              the entire deposit.
     */
    function _unstake(uint256 depositId, uint256 amount) internal returns (uint256 reward) {
        // Fetch stake and make sure it is withdrawable
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        if (depositAmount == 0) revert USR_NoDeposit(depositId);
        if (block.timestamp < s.unlockTimestamp) revert USR_StakeLocked(depositId);

        // Start unstaking

        // Can pass MAX_UINT to make sure all is unstaked
        if (amount > depositAmount) {
            amount = depositAmount;
        }

        // Do share accounting and figure out how many to burn
        (uint256 boost, ) = _getBoost(s.lock);
        uint256 amountWithBoost = amount + (amount * boost) / ONE;
        uint256 sharesToBurn = (totalShares * amountWithBoost) / totalDepositsWithBoost;

        if (sharesToBurn == 0) revert USR_UnstakeTooSmall(amount);
        if (sharesToBurn > s.shares) revert ACCT_TooManySharesBurned(msg.sender, depositId, sharesToBurn, s.shares);

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

    /**
     * @notice  Claim rewards for a given deposit.
     * @dev     Rewards accumulate linearly since deposit.
     *
     * @param depositId             The specified deposit for which to claim rewards.
     *
     * @return reward               The amount of accumulated rewards since the last reward claim.
     */
    function claim(uint256 depositId)
        external
        override
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256 reward)
    {
        return _claim(depositId);
    }

    /**
     * @notice  Claim all available rewards.
     * @dev     Rewards accumulate linearly.
     *
     *
     * @return rewards               The amount of accumulated rewards since the last reward claim.
     *                               Each element of the array specified rewards for the corresponding
     *                               indexed deposit.
     */
    function claimAll()
        external
        override
        whenNotPaused
        checkSupplyAccounting
        updateTotalRewardAccounting
        updateUserRewardAccounting(msg.sender)
        updateRewardsLeft
        returns (uint256[] memory rewards)
    {
        // Individually claim for each stake
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            rewards[i] = _claim(depositIds[i]);
        }
    }

    /**
     * @dev Contains all logic for processing a claim operation.
     *      Relies on previous reward accounting done before
     *      processing external functions. Updates the amount
     *      of rewards claimed so rewards cannot be claimed twice.
     *
     *
     * @param depositId             The specified deposit to claim rewards for.
     *
     * @return reward               The amount of accumulated rewards since the last reward claim.
     */
    function _claim(uint256 depositId) internal returns (uint256 reward) {
        // Fetch stake and make sure it is valid
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        if (depositAmount == 0) revert USR_NoDeposit(depositId);

        // Increment rewards
        reward = s.totalRewardsEarned - s.rewardsClaimed;
        s.rewardsClaimed += reward;

        // Distribute reward
        distributionToken.safeTransfer(msg.sender, reward);

        emit Claim(msg.sender, depositId, reward);
    }

    /**
     * @notice  Unstake and return all staked tokens to the caller.
     * @dev     In emergency node, staking time locks do not apply.
     */
    function emergencyUnstake() external override {
        if (!ended) revert STATE_NoEmergencyUnstake();

        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];
            stakingToken.transfer(msg.sender, s.amount);
            s.amount = 0;
        }
    }

    /**
     * @notice  Claim any accumulated rewards in emergency mode.
     * @dev     In emergency node, no additional reward accounting is done.
     *          Rewards do not accumulate after emergency mode begins,
     *          so any earned amount is only retroactive to when the contract
     *          was active.
     */
    function emergencyClaim() external override {
        if (!ended) revert STATE_NoEmergencyUnstake();
        if (!claimable) revert STATE_NoEmergencyClaim();

        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];
            uint256 reward = s.totalRewardsEarned - s.rewardsClaimed;

            distributionToken.safeTransfer(msg.sender, reward);

            s.totalRewardsEarned = 0;
        }
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Specify an initial epoch schedule for staking rewards.
     * @dev    Can only be called by owner. Owner must approve distributionToken for withdrawal.
     *
     * @param _rewardsPerEpoch      The total reward pool for each epoch.
     * @param _epochLength          The length of each epoch in seconds.
     * @param _numEpochs            The number of epochs to schedule.
     */
    function initializePool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external override onlyOwner {
        if (startTimestamp > 0) revert STATE_AlreadyInitialized();
        if (_numEpochs == 0) revert USR_NoEpochs();
        if (_numEpochs > maxNumEpochs) revert USR_TooManyEpochs(_numEpochs, maxNumEpochs);
        if (_epochLength == 0) revert USR_ZeroEpochLength();
        if (_rewardsPerEpoch == 0) revert USR_ZeroRewardsPerEpoch();

        // Mark starting point for rewards accounting
        paused = false;
        startTimestamp = block.timestamp;
        lastAccountingTimestamp = startTimestamp;
        uint256 currentTimestamp = startTimestamp;

        // Create new epochs
        for (uint256 i = 0; i < _numEpochs; i++) {
            rewardEpochs.push(RewardEpoch(currentTimestamp, _epochLength, _rewardsPerEpoch, 0, 0));
            currentTimestamp += _epochLength;
        }

        endTimestamp = currentTimestamp;

        // Fund reward pool from owner
        uint256 rewardAmount = _rewardsPerEpoch * _numEpochs;
        distributionToken.safeTransferFrom(msg.sender, address(this), rewardAmount);

        emit Funding(address(stakingToken), address(distributionToken), rewardAmount);
    }

    /**
     * @notice Specify future epoch schedules for staking rewards.
     * @dev    Can only be called by owner. Owner must approve distributionToken for withdrawal.
     *
     * @param _rewardsPerEpoch      The total reward pool for each epoch.
     * @param _epochLength          The length of each epoch in seconds.
     * @param _numEpochs            The number of epochs to schedule.
     */
    function replenishPool(
        uint256 _rewardsPerEpoch,
        uint256 _epochLength,
        uint256 _numEpochs
    ) external override whenNotPaused onlyOwner {
        if (_numEpochs == 0) revert USR_NoEpochs();
        if (rewardEpochs.length + _numEpochs > maxNumEpochs)
            revert USR_TooManyEpochs(rewardEpochs.length + _numEpochs, maxNumEpochs);
        if (_epochLength == 0) revert USR_ZeroEpochLength();
        if (_rewardsPerEpoch == 0) revert USR_ZeroRewardsPerEpoch();

        RewardEpoch memory lastEpoch = rewardEpochs[rewardEpochs.length - 1];
        if (lastEpoch.startTimestamp > 0) revert ACCT_NoPreviousEpoch();

        uint256 currentTimestamp = lastEpoch.startTimestamp + lastEpoch.duration;

        // Create new epochs
        for (uint256 i = 0; i < _numEpochs; i++) {
            rewardEpochs.push(RewardEpoch(currentTimestamp, _epochLength, _rewardsPerEpoch, 0, 0));
            currentTimestamp += _epochLength;
        }

        endTimestamp = currentTimestamp;

        // Fund reward pool from owner
        uint256 rewardAmount = _rewardsPerEpoch * _numEpochs;
        distributionToken.safeTransferFrom(msg.sender, address(this), rewardAmount);

        emit Funding(address(stakingToken), address(distributionToken), rewardAmount);
    }

    /**
     * @notice Specify a minimum deposit for staking.
     * @dev    Can only be called by owner. Should be used if shares get large
     *         enough that USR_StakeTooSmall commonly triggers.
     *
     * @param _minimum              The minimum deposit for each new stake.
     */
    function updateMinimumDeposit(uint256 _minimum) external override onlyOwner {
        minimumDeposit = _minimum;
    }

    /**
     * @notice Pause the contract. Pausing prevents staking, unstaking, claiming
     *         rewards, and scheduling new reward epochs. Should only be used
     *         in an emergency.
     *
     * @param _paused               Whether the contract should be paused.
     */
    function setPaused(bool _paused) external override onlyOwner {
        if (_paused == false && startTimestamp == 0) {
            revert STATE_NotInitialized();
        }

        paused = _paused;
    }

    /**
     * @notice Stops the contract - this is irreversible. Should only be used
     *         in an emergency, for example an irreversible accounting bug
     *         or an exploit. Enables all depositors to withdraw their stake
     *         instantly. Also stops new rewards accounting.
     *
     * @param makeRewardsClaimable  Whether any previously accumulated rewards should be claimable.
     */
    function emergencyStop(bool makeRewardsClaimable) external override onlyOwner {
        if (ended) revert STATE_AlreadyStopped();

        // Update state and put in irreversible emergency mode
        ended = true;
        claimable = makeRewardsClaimable;

        if (!claimable) {
            // Send distribution token back to owner
            distributionToken.transfer(msg.sender, distributionToken.balanceOf(address(this)));
        }

        emit EmergencyStop(msg.sender, makeRewardsClaimable);
    }

    // ======================================= STATE INFORMATION =======================================

    /**
     * @notice Returns the current epoch index. Reverts if there is no currently active epoch.
     *
     * @return The index of the currently active epoch.
     */
    function currentEpoch() public view override returns (uint256) {
        return epochAtTime(block.timestamp);
    }

    /**
     * @notice Returns the epoch index for a given timestamp. Reverts if there is no
     *         active epoch for the specified time.
     *
     * @param timestamp             The timestamp for which to look up the epoch.
     *
     * @return epochIdx             The index of the currently active epoch.
     */
    function epochAtTime(uint256 timestamp) public view override returns (uint256 epochIdx) {
        // Return current epoch index
        uint256 timeElapsed = timestamp - startTimestamp;

        while (timeElapsed > 0) {
            if (epochIdx > rewardEpochs.length - 1) {
                revert USR_NoEpochAtTime(timestamp);
            }

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

    /**
     * @notice Returns the total amount of rewards scheduled across all epochs (past and future).
     *
     * @return amount               The total amount of rewards for the staking schedule.
     */
    function totalRewards() public view override returns (uint256 amount) {
        amount = 0;

        for (uint256 i = 0; i < rewardEpochs.length; i++) {
            amount += rewardEpochs[i].totalRewards;
        }
    }

    /**
     * @notice Returns user stake info.
     * @dev    Used to circumvent limitations around returning nested mappings.
     *
     * @param user                  The user to query.
     * @param depositId             The depositId for the user used to look up the stake.
     *
     * @return                      The stake information for the specified depositId;
     */
    function getUserStake(address user, uint256 depositId) public view override returns (UserStake memory) {
        return stakes[user][depositId];
    }

    /**
     * @notice Returns list of deposit IDs for user.
     * @dev    Used to circumvent limitations around returning complex types.
     *
     * @param user                  The user to query.
     *
     * @return                      The list of deposit IDs.
     */
    function getAllUserStakes(address user) public view override returns (uint256[] memory) {
        return allUserStakes[user];
    }

    /**
     * @notice Returns the index in userStakes of depositId.
     * @dev    Used to circumvent limitations around returning complex types.
     *
     * @param user                  The user to query.
     * @param depositId             The depositId for the user used to find the index of.
     *
     * @return                      The index of the given depositId.
     */
    function getDepositIdIdx(address user, uint256 depositId) public view override returns (uint256) {
        return depositIdIdx[user][depositId];
    }

    /**
     * @notice Returns the current deposit index of a user.
     * @dev    Used to circumvent limitations around returning complex types.
     *
     * @param user                  The user to query.
     *
     * @return                      The current deposit index.
     */
    function getCurrentUserDepositIdx(address user) public view override returns (uint256) {
        return currentUserDepositIdx[user];
    }

    /**
     * @notice Returns information for a specific reward epoch.
     * @dev    Used to circumvent limitations around returning complex types.
     *
     * @param idx                   The index of the reward epoch to lookup.
     *
     * @return                      The epoch information.
     */
    function getRewardEpoch(uint256 idx) public view override returns (RewardEpoch memory) {
        return rewardEpochs[idx];
    }

    // ============================================ HELPERS ============================================

    /**
     * @dev Check for any accounting inconsistencies. Called before any account-mutating operation.
     */
    modifier checkSupplyAccounting() {
        _checkSupplyAccounting();

        _;
    }

    /**
     * @dev Update reward accounting for the global state totals. Since every epoch has a
     *      potentially different rewards schedule, must be done epoch by epoch. Called before any
     *      account-mutating operation, such that share accounting is done correctly.
     *
     * @dev Assumes all epochs distribute rewards linearly.
     */
    modifier updateTotalRewardAccounting() {
        // Only update if program hasn't ended or program has ended but accounting hasn't caught up
        bool rewardsOngoing = block.timestamp < endTimestamp;
        if (rewardsOngoing || lastAccountingTimestamp < endTimestamp) {
            uint256 epochNow = rewardsOngoing ? currentEpoch() : epochAtTime(endTimestamp - 1);
            uint256 epochAtLastAccounting = epochAtTime(lastAccountingTimestamp);

            // For each epoch in window, calculate rewards
            for (uint256 i = epochAtLastAccounting; i <= epochNow; i++) {
                _calculateTotalRewardsForEpoch(rewardEpochs[i]);
            }

            lastAccountingTimestamp = block.timestamp;
        }

        _;
    }

    /**
     * @dev Update reward accounting for a particular user. Must be done stake-by-stake, and
     *      epoch-by-epoch within each stake, since stakes are deposited at different times
     *      and accumulate their own share-seconds for each epoch.
     *
     * @dev Assumes all epochs distribute rewards linearly.
     */
    modifier updateUserRewardAccounting(address user) {
        bool rewardsOngoing = block.timestamp < endTimestamp;

        // Similar to total reward accounting, but must be done for each user stake
        uint256[] memory userStakes = allUserStakes[user];

        for (uint256 i = 0; i < userStakes.length; i++) {
            // Get stake info based on depositId
            UserStake storage s = stakes[user][userStakes[i]];

            // If shares are 0, stake is no longer relevant - it has been unstaked
            // Only update if program hasn't ended or program has ended but accounting hasn't caught up
            if (s.shares > 0 && (rewardsOngoing || s.lastAccountingTimestamp < endTimestamp)) {
                // Calculate time passed since stake was last accounted for
                uint256 epochNow = rewardsOngoing ? currentEpoch() : epochAtTime(endTimestamp - 1);
                uint256 epochAtLastAccounting = epochAtTime(s.lastAccountingTimestamp);
                uint256 totalRewardsEarned = 0;

                // For each epoch in window, calculate rewards
                for (uint256 j = epochAtLastAccounting; j <= epochNow; i++) {
                    totalRewardsEarned += _calculateStakeRewardsForEpoch(i, s);
                }

                // Overwrite, not increment, the accrued rewards. Previous loop
                // always calculates the total epoch rewards
                s.totalRewardsEarned = totalRewardsEarned;
                s.lastAccountingTimestamp = block.timestamp;
            }
        }

        _;
    }

    /**
     * @dev Update total amount of rewards left in schedule. Used to protect
     *      against new staking if there are no more rewards to earn.
     */
    modifier updateRewardsLeft() {
        uint256 amount = 0;

        for (uint256 i = 0; i < rewardEpochs.length; i++) {
            RewardEpoch memory e = rewardEpochs[i];
            amount += e.totalRewards - e.rewardsEarned;
        }

        rewardsLeft = amount;

        _;
    }

    /**
     * @dev Blocks calls if contract is paused or killed.
     */
    modifier whenNotPaused() {
        if (paused) revert STATE_ContractPaused();
        if (ended) revert STATE_ContractKilled();
        _;
    }

    /**
     * @dev Updates global state by calculating newly accumulated rewards
     *      since last accounting timestamp, for a given epoch. Makes sure that
     *      if an epoch is over, the entire reward pool has been accumulated.
     */
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
            if (epoch.rewardsEarned != epoch.totalRewards)
                revert ACCT_PastEpochRewards(epoch.rewardsEarned, epoch.totalRewards);
        }

        // Figure out total share-seconds accumulated
        uint256 shareSecondsAcc = timeElapsed * totalShares;
        totalShareSeconds += shareSecondsAcc;
        epoch.shareSecondsAccumulated += shareSecondsAcc;
    }

    /**
     * @dev Updates a stake's state by calculating newly accumulated rewards
     *      since last accounting timestamp, for a given epoch and stake.
     */
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

        return rewardsEarnedForEpoch;
    }

    /**
     * @dev Check for any accounting inconsistencies. Called before any account-mutating operation.
     */
    function _checkSupplyAccounting() internal view {
        uint256 tokenBalance = distributionToken.balanceOf(address(this));

        // If staking token is same as distribution token, remove deposits
        if (address(stakingToken) == address(distributionToken)) {
            tokenBalance -= totalDeposits;
        }

        if (tokenBalance < rewardsLeft) revert ACCT_CannotFundRewards(tokenBalance, rewardsLeft);
        if (totalShares > 0 && totalDeposits == 0) revert ACCT_SharesWithoutDeposits(totalShares, totalDeposits);
    }

    /**
     * @dev Maps Lock enum values to corresponding lengths of time and reward boosts.
     */
    function _getBoost(Lock _lock) internal pure returns (uint256 boost, uint256 timelock) {
        if (_lock == Lock.day) {
            return (ONE_DAY_BOOST, ONE_DAY);
        } else if (_lock == Lock.week) {
            return (ONE_WEEK_BOOST, ONE_WEEK);
        } else if (_lock == Lock.twoWeeks) {
            return (TWO_WEEKS_BOOST, TWO_WEEKS);
        } else {
            revert USR_InvalidLockValue(uint256(_lock));
        }
    }
}
