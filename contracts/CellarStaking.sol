// SPDX-License-Identifier: MIT
pragma solidity >=0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./Errors.sol";
import "./interfaces/ICellarStaking.sol";
import "hardhat/console.sol";

// TODO:
// Fix tests
// Fix docs

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
 *    may not unstake until they choose to unbond, and time defined by the lock has
 *    elapsed during unbonding.
 * 2) When a user wishes to withdraw, they must first "unbond" their stake, which starts
 *    a timer equivalent to the lock time.
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
    uint256 public override epochDuration;

    uint256 public override minimumDeposit = 0;
    uint256 public override endTimestamp;
    uint256 public override totalDeposits;
    uint256 public override totalDepositsWithBoost;
    uint256 public override rewardRate;
    uint256 public override rewardPerTokenStored;

    uint256 private lastAccountingTimestamp = block.timestamp;

    /// @notice Emergency states in case of contract malfunction.
    bool public override paused;
    bool public override ended;
    bool public override claimable;

    /// @notice Tracks if an address can call notifyReward()
    mapping(address => bool) public isRewardDistributor;

    // ============= User State ==============

    /// @notice user => depositId => UserInfo
    mapping(address => mapping(uint256 => UserStake)) public stakes;
    /// @notice user => depositId[]
    mapping(address => uint256[]) public allUserStakes;
    /// @notice user => depositId => index in allUserStakes
    // TODO: try to remove this
    mapping(address => mapping(uint256 => uint256)) public depositIdIdx;
    /// @notice user => current index of user deposit array
    mapping(address => uint256) public currentUserDepositIdx;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @param _owner                The owner of the staking contract - will immediately receive ownership.
     * @param _rewardsDistribution  The address allowed to schedule new rewards.
     * @param _stakingToken         The token users will deposit in order to stake.
     * @param _distributionToken    The token the staking contract will distribute as rewards.
     * @param _epochDuration        The length of a reward schedule.
     */
    constructor(
        address _owner,
        address _rewardsDistribution,
        ERC20 _stakingToken,
        ERC20 _distributionToken,
        uint256 _epochDuration
    ) {
        stakingToken = _stakingToken;
        isRewardDistributor[_rewardsDistribution] = true;
        distributionToken = _distributionToken;
        epochDuration = _epochDuration;

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
        updateRewards
    {
        if (amount == 0) revert USR_ZeroDeposit();
        if (amount < minimumDeposit) revert USR_MinimumDeposit(amount, minimumDeposit);
        if (block.timestamp > endTimestamp) revert STATE_NoRewardsLeft();

        // Record deposit
        uint256 depositId = currentUserDepositIdx[msg.sender]++;
        depositIdIdx[msg.sender][depositId] = allUserStakes[msg.sender].length;
        allUserStakes[msg.sender].push(depositId);
        UserStake storage s = stakes[msg.sender][depositId];

        // Do share accounting and populate user stake information
        (uint256 boost, ) = _getBoost(lock);
        uint256 amountWithBoost = amount + (amount * boost / ONE);

        s.amount = amount;
        s.amountWithBoost = amountWithBoost;
        s.rewardPerTokenPaid = rewardPerTokenStored;
        s.rewards = 0;
        s.unbondTimestamp = 0;
        s.lock = lock;

        // Update global state
        totalDeposits += amount;
        totalDepositsWithBoost += amountWithBoost;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Stake(msg.sender, depositId, amount);
    }

    /**
     * @notice  Unbond a specified amount from a certain deposited stake.
     * @dev     After the unbond time elapses, the deposit can be unstaked.
     *
     * @param depositId             The specified deposit to unstake from.
     *
     */
    function unbond(uint256 depositId)
        external
        override
        whenNotPaused
        updateRewards
    {
        _unbond(depositId);
    }

    /**
     * @notice  Unbond all user deposits.
     * @dev     Different deposits may have different timelocks.
     *
     */
    function unbondAll()
        external
        override
        whenNotPaused
        updateRewards
    {
        // Individually unbond each deposit
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];

            if (s.unbondTimestamp == 0) {
                _unbond(depositIds[i]);
            }
        }
    }

    /**
     * @dev     Contains all logic for processing an unbond operation.
     *          For the given deposit, sets an unlock time, and
     *          reverts boosts to 0.
     *
     * @param depositId             The specified deposit to unbond from.
     */
    function _unbond(uint256 depositId) internal {
        // Fetch stake and make sure it is withdrawable
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        if (depositAmount == 0) revert USR_NoDeposit(depositId);
        if (s.unbondTimestamp > 0) revert USR_AlreadyUnbonding(depositId);

        _updateRewardForStake(msg.sender, depositId);

        // Remove any lock boosts
        uint256 depositAmountReduced = s.amountWithBoost - depositAmount;
        (, uint256 lockDuration) = _getBoost(s.lock);

        s.amountWithBoost = depositAmount;
        s.unbondTimestamp = block.timestamp + lockDuration;

        totalDepositsWithBoost -= depositAmountReduced;

        emit Unbond(msg.sender, depositId, depositAmount);
    }

    /**
     * @notice  Cancel an unbonding period for a stake that is currently unbonding.
     * @dev     Resets the unbonding timer and reinstates any lock boosts.
     *
     * @param depositId             The specified deposit to unstake from.
     *
     */
    function cancelUnbonding(uint256 depositId)
        external
        override
        whenNotPaused
        updateRewards
    {
        _cancelUnbonding(depositId);
    }

    /**
     * @notice  Cancel an unbonding period for all stakes.
     * @dev     Only cancels stakes that are unbonding.
     *
     */
    function cancelUnbondingAll()
        external
        override
        whenNotPaused
        updateRewards
    {
        // Individually unbond each deposit
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];

            if (s.unbondTimestamp > 0) {
                _cancelUnbonding(depositIds[i]);
            }
        }
    }

    /**
     * @dev     Contains all logic for cancelling an unbond operation.
     *          For the given deposit, resets the unbonding timer, and
     *          reverts boosts to amount determined by lock.
     *
     * @param depositId             The specified deposit to unbond from.
     */
    function _cancelUnbonding(uint256 depositId) internal {
        // Fetch stake and make sure it is withdrawable
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;
        if (depositAmount == 0) revert USR_NoDeposit(depositId);
        if (s.unbondTimestamp == 0) revert USR_NotUnbonding(depositId);

        _updateRewardForStake(msg.sender, depositId);

        // Reinstate
        (uint256 boost, ) = _getBoost(s.lock);
        uint256 amountWithBoost = s.amount + (s.amount * boost) / ONE;
        uint256 depositAmountIncreased = amountWithBoost - s.amountWithBoost;

        s.amountWithBoost = amountWithBoost;
        s.unbondTimestamp = 0;

        totalDepositsWithBoost += depositAmountIncreased;

        emit CancelUnbond(msg.sender, depositId);
    }

    /**
     * @notice  Unstake a specific deposited stake.
     * @dev     The unbonding time for the specified deposit must have elapsed.
     * @dev     Unstaking automatically claims available rewards for the deposit.
     *
     * @param depositId             The specified deposit to unstake from.
     *
     * @return reward               The amount of accumulated rewards since the last reward claim.
     */
    function unstake(uint256 depositId)
        external
        override
        whenNotPaused
        updateRewards
        returns (uint256 reward)
    {
        return _unstake(depositId);
    }

    /**
     * @notice  Unstake all user deposits.
     * @dev     Only unstakes rewards that are unbonded.
     * @dev     Unstaking automatically claims all available rewards.
     *
     * @return rewards              The amount of accumulated rewards since the last reward claim.
     */
    function unstakeAll()
        external
        override
        whenNotPaused
        updateRewards
        returns (uint256[] memory)
    {
        // Individually unstake each deposit
        uint256[] memory depositIds = allUserStakes[msg.sender];
        uint256[] memory rewards = new uint256[](depositIds.length);

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];

            if (s.unbondTimestamp > 0 && block.timestamp >= s.unbondTimestamp) {
                rewards[i] = _unstake(depositIds[i]);
            }
        }

        return rewards;
    }

    /**
     * @dev     Contains all logic for processing an unstake operation.
     *          For the given deposit, does share accounting and burns
     *          shares, returns staking tokens to the original owner,
     *          updates global deposit and share trackers, and claims
     *          rewards for the given deposit.
     *
     * @param depositId             The specified deposit to unstake from.
     */
    function _unstake(uint256 depositId) internal returns (uint256 reward) {
        // Fetch stake and make sure it is withdrawable
        UserStake storage s = stakes[msg.sender][depositId];

        uint256 depositAmount = s.amount;

        if (depositAmount == 0) revert USR_NoDeposit(depositId);
        if (s.unbondTimestamp == 0 || block.timestamp < s.unbondTimestamp) revert USR_StakeLocked(depositId);

        _updateRewardForStake(msg.sender, depositId);

        // Start unstaking
        uint256 amountWithBoost = s.amountWithBoost;
        reward = s.rewards;

        s.amount = 0;
        s.amountWithBoost = 0;
        s.rewards = 0;

        // Update global state
        totalDeposits -= depositAmount;
        totalDepositsWithBoost -= amountWithBoost;

        // Distribute stake
        stakingToken.safeTransfer(msg.sender, depositAmount);

        // Distribute reward
        distributionToken.safeTransfer(msg.sender, reward);

        emit Unstake(msg.sender, depositId, depositAmount, reward);
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
        updateRewards
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
        updateRewards
        returns (uint256[] memory rewards)
    {
        // Individually claim for each stake
        uint256[] memory depositIds = allUserStakes[msg.sender];
        rewards = new uint256[](depositIds.length);

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

        _updateRewardForStake(msg.sender, depositId);

        reward = s.rewards;

        // Distribute reward
        if (reward > 0) {
            s.rewards = 0;

            distributionToken.safeTransfer(msg.sender, reward);

            emit Claim(msg.sender, depositId, reward);
        }
    }

    /**
     * @notice  Unstake and return all staked tokens to the caller.
     * @dev     In emergency mode, staking time locks do not apply.
     */
    function emergencyUnstake() external override {
        if (!ended) revert STATE_NoEmergencyUnstake();

        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];
            uint256 amount = s.amount;

            if (amount > 0) {
                s.amount = 0;

                stakingToken.transfer(msg.sender, amount);

                emit EmergencyUnstake(msg.sender, depositIds[i], amount);
            }
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

        uint256 reward;
        uint256[] memory depositIds = allUserStakes[msg.sender];

        for (uint256 i = 0; i < depositIds.length; i++) {
            UserStake storage s = stakes[msg.sender][depositIds[i]];

            reward += s.rewards;
            s.rewards = 0;
        }

        if (reward > 0)  {
            distributionToken.safeTransfer(msg.sender, reward);

            // No need for per-stake events like emergencyUnstake:
            // don't need to make sure positions were unwound
            emit EmergencyClaim(msg.sender, reward);
        }
    }

    // ======================================== ADMIN OPERATIONS ========================================

    /**
     * @notice Specify a new schedule for staking rewards.
     * @dev    Can only be called by reward distributor. Owner must approve distributionToken for withdrawal.
     *
     * @param reward                The amount of rewards to distribute per second.
     */
    function notifyRewardAmount(
        uint256 reward
    ) external override onlyRewardsDistribution updateRewards {
        if (reward < epochDuration) revert USR_ZeroRewardsPerEpoch();

        if (block.timestamp >= endTimestamp) {
            // Set new rate bc previous has already expired
            rewardRate = reward / epochDuration;
        } else {
            uint256 remaining = endTimestamp - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (reward + leftover) / epochDuration;
        }

        // prevent overflow when computing rewardPerToken
        if (rewardRate >= ((type(uint256).max / ONE) / epochDuration)) {
            revert USR_RewardTooLarge();
        }

        endTimestamp = block.timestamp + epochDuration;

        // Source rewards
        distributionToken.safeTransferFrom(msg.sender, address(this), reward);

        emit Funding(reward, endTimestamp);
    }

    /**
     * @notice Change the length of a reward epoch for future reward schedules.
     *
     * @param _epochDuration        The new duration for reward schedules.
     */
    function setRewardsDuration(uint256 _epochDuration) external override onlyOwner {
        epochDuration = _epochDuration;
        emit EpochDurationChange(epochDuration);
    }

    /**
     * @notice Specify a minimum deposit for staking.
     * @dev    Can only be called by owner.
     *
     * @param _minimum              The minimum deposit for each new stake.
     */
    function setMinimumDeposit(uint256 _minimum) external override onlyOwner {
        minimumDeposit = _minimum;
    }

    /**
     * @notice Pause the contract. Pausing prevents staking, unstaking, claiming
     *         rewards, and scheduling new rewards. Should only be used
     *         in an emergency.
     *
     * @param _paused               Whether the contract should be paused.
     */
    function setPaused(bool _paused) external override onlyOwner {
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

    /**
     * @notice Set the EOA or contract allowed to call 'notifyRewardAmount' to schedule
     *         new rewards.
     *
     * @param _rewardsDistribution  The new reward distributor.
     * @param _set                  Whether the address should be allowed to distribute.
     */
    function setRewardsDistribution(address _rewardsDistribution, bool _set) external override onlyOwner {
        isRewardDistributor[_rewardsDistribution] = _set;

        emit DistributorSet(_rewardsDistribution, _set);
    }

    // ======================================= STATE INFORMATION =======================================

    /**
     * @notice Returns the latest time to account for in the reward program.
     *
     * @return timestamp           The latest time to calculate.
     */
    function latestRewardsTimestamp() public view override returns (uint256) {
        return
            block.timestamp < endTimestamp
                ? block.timestamp
                : endTimestamp;
    }

    /**
     * @notice Returns the amount of reward to distribute per currently-depostied token.
     *         Will update on changes to total deposit balance or reward rate.
     * @dev    Sets rewardPerTokenStored.
     *
     *
     * @return rewardPerToken           The latest time to calculate.
     */
    function rewardPerToken() public view override returns (uint256) {
        if (totalDeposits == 0) return rewardPerTokenStored;

        uint256 timeElapsed = latestRewardsTimestamp() - lastAccountingTimestamp;
        uint256 rewardsForTime = timeElapsed * rewardRate;
        uint256 newRewardsPerToken = rewardsForTime * ONE / totalDepositsWithBoost;

        return rewardPerTokenStored + newRewardsPerToken;
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

    // ============================================ HELPERS ============================================

    /**
     * @dev Can only be called by the designated reward distributor
     */
    modifier onlyRewardsDistribution() {
        if(!isRewardDistributor[msg.sender]) revert USR_NotDistributor();

        _;
    }

    /**
     * @dev Update reward accounting for the global state totals.
     */
    modifier updateRewards() {
        rewardPerTokenStored = rewardPerToken();
        lastAccountingTimestamp = latestRewardsTimestamp();

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
     * @dev Update reward for a specific user stake.
     */
    function _updateRewardForStake(address user, uint256 depositId) internal {
        UserStake storage s = stakes[user][depositId];
        if (s.amount == 0) return;

        uint256 earned = _earned(s);
        s.rewards += earned;

        s.rewardPerTokenPaid = rewardPerTokenStored;
    }

    /**
     * @dev Return how many rewards a stake has earned and has claimable.
     */
    function _earned(UserStake memory s) internal view returns (uint256) {
        uint256 rewardPerTokenAcc = rewardPerTokenStored - s.rewardPerTokenPaid;
        uint256 newRewards = s.amountWithBoost * (rewardPerTokenAcc / ONE);
        return newRewards;
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
