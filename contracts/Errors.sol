// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

// ========================================== USER ERRORS ===========================================

error USR_MinimumDeposit(uint256 minimum, uint256 amount);

error USR_StakeTooSmall(uint256 amount);

error USR_ZeroUnstake();

error USR_NoDepositId(uint256 depositId);

error USR_StakeLocked(uint256 depositId);

error USR_UnstakeTooSmall(uint256 amount);

error USR_NoEpochs();

error USR_TooManyEpochs(uint256 numEpochs, uint256 maximum);

error USR_ZeroEpochLength();

error USR_ZeroRewardsPerEpoch();

// ========================================== STATE ERRORS ==========================================

error STATE_NotInitialized();

error STATE_AlreadyInitialized();

error STATE_NoRewardsLeft();

error STATE_NoEmergencyUnstake();

error STATE_NoEmergencyClaim();

error STATE_AlreadyStopped();

error STATE_ContractPaused();

error STATE_ContractKilled();

error STATE_NoEpochAtTime(uint256 timestamp);

// ======================================== ACCOUNTING ERRORS =======================================

error ACCT_TooManySharesBurned(uint256 sharesToBurn, uint256 stakeShares);

error ACCT_NoPreviousEpoch();

error ACCT_PastEpochRewards(uint256 epochRewardsEarned, uint256 epochTotalRewards);

error ACCT_CannotFundRewards(uint256 tokenBalance, uint256 rewardsLeft);

error ACCT_SharesWithoutDeposits(uint256 totalShares, uint256 totalDeposits);
