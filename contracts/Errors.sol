// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

// ========================================== USER ERRORS ===========================================
/// These errors represent invalid user input to functions.
///
/// Where appropriate, the invalid value is specified along with constraints.
///
/// These errors can be resolved by callers updating their arguments.

/**
 * @notice User attempted to stake an amount smaller than the minimu deposit.
 *
 * @param amount Amount user attmpted to stake.
 * @param minimumDeposit The minimum deopsit amount accepted.
 */
error USR_MinimumDeposit(uint256 amount, uint256 minimumDeposit);

/**
 * @notice Amount user attempted to stake is equivalent to zero staking shares after division.
 * @dev    If this occurs, the admin should look at increasing the minimum deposit size.
 *
 * @param amount The amount of tokens the user attmpted to stake.
 */
error USR_StakeTooSmall(uint256 amount);

/**
 * @notice The user attempted to unstake 0 tokens.
 */
error USR_ZeroUnstake();

/**
 * @notice The specified deposit ID does not exist for the caller.
 *
 * @param depositId The deposit ID provided for lookup.
 */
error USR_NoDeposit(uint256 depositId);

/**
 * @notice The user is attempting to unstake a deposit which is still timelocked.
 *
 * @param depositId The deposit ID the user attempted to unstake.
 */
error USR_StakeLocked(uint256 depositId);

/**
 * @notice The user is attempting to unstake an amount which is equivalent to zero staking shares.
 *
 * @param amount The amount of tokens the user attempted to unstake.
 */
error USR_UnstakeTooSmall(uint256 amount);

/**
 * @notice The contract owner attempted to update rewards but specified 0 epochs.
 */
error USR_NoEpochs();

/**
 * @notice The contract owner attempted to update rewards but specified too many initial or incremental epochs.
 * @dev    The maximum number of epochs is set at contract creation time and protects against the block gas limit.
 *
 * @param numEpochs The number of reward epochs that would have existed as a result of the call.
 * @param maximum The total allowed number of reward epochs.
 */
error USR_TooManyEpochs(uint256 numEpochs, uint256 maximum);

/**
 * @notice The contract owner attempted to update rewards but specified an epoch of length 0.
 */
error USR_ZeroEpochLength();

/**
 * @notice The contract owner attempted to update rewards but 0 rewards per epoch.
 */
error USR_ZeroRewardsPerEpoch();

/**
 * @notice The contract owner attempted to look up the index of the epoch for the
 *         given timestamp, but there is no reward epoch scheduled for that time.
 *
 * @param timestamp The timestamp for which epoch lookup was attempted.
 */
error USR_NoEpochAtTime(uint256 timestamp);

/**
 * @notice The caller attempted to stake with a lock value that did not
 *         correspond to a valid staking time.
 *
 * @param lock The provided lock value.
 */
error USR_InvalidLockValue(uint256 lock);

// ========================================== STATE ERRORS ==========================================
/// These errors represent actions that are being prevented due to current contract state.
///
/// These errors do not relate to user input, and may or may not be resolved by other actions
///     or the progression of time.

/**
 * @notice The caller attempted to perform an action which required the pool to be initialized.
 */
error STATE_NotInitialized();

/**
 * @notice The caller attempted to initialize the pool more than once.
 */
error STATE_AlreadyInitialized();

/**
 * @notice The caller attempted to deposit stake, but there are no remaining rewards to pay out.
 */
error STATE_NoRewardsLeft();

/**
 * @notice The caller attempted to perform an an emergency unstake, but the contract
 *         is not in emergency mode.
 */
error STATE_NoEmergencyUnstake();

/**
 * @notice The caller attempted to perform an an emergency unstake, but the contract
 *         is not in emergency mode, or the emergency mode does not allow claiming rewards.
 */
error STATE_NoEmergencyClaim();

/**
 * @notice The owner attempted to place the contract in emergency mode, but emergency
 *         mode was already enabled.
 */
error STATE_AlreadyStopped();

/**
 * @notice The caller attempted to perform a state-mutating action (e.g. staking or unstaking)
 *         while the contract was paused.
 */
error STATE_ContractPaused();

/**
 * @notice The caller attempted to perform a state-mutating action (e.g. staking or unstaking)
 *         while the contract was killed (placed in emergency mode).
 * @dev    Emergency mode is irreversible.
 */
error STATE_ContractKilled();

// ======================================== ACCOUNTING ERRORS =======================================
/// These are errors that surface inconsistent accounting and are potentially serious.
///
/// They should not occur in normal contract operation and indicate the presence of an
///     implementation error in accounting, or possible malicious activity.
///
/// Any accounting error should be looked at closely and the root cause should be determined.
///
/// Some accounting errors may be unrecoverable and require killing the contract and
///     refunding stakers.

/**
 * @notice When a user attempted to unstake, accounting logic determined the number
 *         of shares to burn, and it was more than the shares the user was awarded on deposit.
 *         A user's shares should not change, since they are concentrated/diluted by share
 *         minting and burning on other staknig and unstaking actions. This implies an
 *         accounting mistake in tracking total deposits.
 */
error ACCT_TooManySharesBurned(uint256 sharesToBurn, uint256 stakeShares);

/**
 * @notice The owner attempted to replenish the pool with a new rewards schedule, but the pool
 *         did not have any previous rewards epochs scheduled. This is inconsistent with contract
 *         design since the pool must be initialized before being replenished, and initialization
 *         requires specifying at least one epoch. This implies an implementation error in pool
 *         initialization.
 */
error ACCT_NoPreviousEpoch();

/**
 * @notice When performing accounting for reward epochs, the accounting time for an epoch was
 *         fully consumed, however the total rewards accounted for did not match the originally
 *         specified number of rewards for the epoch. This implies either an accounting error
 *         meaning that reward accumulation accounting was missed for some time window, or an
 *         arithmetic error that led to earned rewards not being correctly accumulated for
 *         the epoch.
 */
error ACCT_PastEpochRewards(uint256 epochRewardsEarned, uint256 epochTotalRewards);

/**
 * @notice The contract's token balance of the distribution token is smaller than the total
 *         amount of rewards scheduled for the future by the previously-defined epochs. This
 *         means that some users will not be able to claim rewards. The error implies either
 *         an issue with funding the distribution token when defining reward schedules, paying
 *         out too much of the token in previously-accounted rewards, or malicious activity
 *         that successfully drained the reward pool.
 */
error ACCT_CannotFundRewards(uint256 tokenBalance, uint256 rewardsLeft);

/**
 * @notice There are shares accounted for in staking contract, but there are not current
 *         deposits, meaning certain users may be able to receive rewards without depositing
 *         the requisite number of tokens. This implies a possible arithmetic issue with
 *         calculating the number of shares to mint or burn on staking and unstaking, an
 *         accounting issue in tracking total deposits, or malicious activity that allowed
 *         a user to mint shares without needing to deposit tokens (or, alternatively, a user
 *         that found a method to withdraw tokens while preserving their shares).
 */
error ACCT_SharesWithoutDeposits(uint256 totalShares, uint256 totalDeposits);
