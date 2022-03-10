// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

// ==================================================================================================
// ===========================                USER ERRORS                ============================
// ==================================================================================================
/// These errors represent invalid user input to functions.
///
/// Where appropriate, the invalid value is specified along with constraints.
///
/// These errors can be resolved by callers updating their arguments.

/**
 * @notice User attempted to stake an amount smaller than the minimu deposit.
 *
 * @param amount                Amount user attmpted to stake.
 * @param minimumDeposit        The minimum deopsit amount accepted.
 */
error USR_MinimumDeposit(uint256 amount, uint256 minimumDeposit);

/**
 * @notice Amount user attempted to stake is equivalent to zero staking shares after division.
 * @dev    If this occurs, the admin should look at increasing the minimum deposit size.
 *
 * @param amount                The amount of tokens the user attmpted to stake.
 */
error USR_StakeTooSmall(uint256 amount);

/**
 * @notice The user attempted to unstake 0 tokens.
 */
error USR_ZeroUnstake();

/**
 * @notice The specified deposit ID does not exist for the caller.
 *
 * @param depositId             The deposit ID provided for lookup.
 */
error USR_NoDeposit(uint256 depositId);

/**
 * @notice The user is attempting to cancel unbonding for a deposit which is not unbonding.
 *
 * @param depositId             The deposit ID the user attempted to cancel.
 */
error USR_NotUnbonding(uint256 depositId);

/**
 * @notice The user is attempting to unbond a deposit which has already been unbonded.
 *
 * @param depositId             The deposit ID the user attempted to unbond.
 */
error USR_AlreadyUnbonding(uint256 depositId);

/**
 * @notice The user is attempting to unstake a deposit which is still timelocked.
 *
 * @param depositId             The deposit ID the user attempted to unstake.
 */
error USR_StakeLocked(uint256 depositId);

/**
 * @notice The user is attempting to unstake an amount which is equivalent to zero staking shares.
 *
 * @param amount                The amount of tokens the user attempted to unstake.
 */
error USR_UnstakeTooSmall(uint256 amount);

/**
 * @notice The contract owner attempted to update rewards but the new reward rate would cause overflow.
 */
error USR_RewardTooLarge();

/**
 * @notice The reward distributor attempted to update rewards but 0 rewards per epoch.
 *         This can also happen if there is less than 1 wei of rewards per second of the
 *         epoch - due to integer division this will also lead to 0 rewards.
 */
error USR_ZeroRewardsPerEpoch();

/**
 * @notice The caller attempted to stake with a lock value that did not
 *         correspond to a valid staking time.
 *
 * @param lock                  The provided lock value.
 */
error USR_InvalidLockValue(uint256 lock);

/**
 * @notice The caller attempted to call a reward distribution function,
 *         but was not the designated distributor.
 *
 */
error USR_NotDistributor();

// ==================================================================================================
// ===========================                STATE ERRORS               ============================
// ==================================================================================================
/// These errors represent actions that are being prevented due to current contract state.
///
/// These errors do not relate to user input, and may or may not be resolved by other actions
///     or the progression of time.

/**
 * @notice The caller attempted to change the epoch length, but current reward epochs were active.
 */
error STATE_RewardsOngoing();

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
