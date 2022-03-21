import hre from "hardhat";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { Contract, Signer, BigNumberish, ContractTransaction } from "ethers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { CellarStaking } from "../src/types/CellarStaking";
import type { MockERC20 } from "../src/types/MockERC20";
import { Test } from "mocha";

const { deployContract } = hre.waffle;

export const ether = ethers.utils.parseEther;

const oneDaySec = 60 * 60 * 24;
const oneWeekSec = oneDaySec * 7;
const oneMonthSec = oneDaySec * 30;

const lockDay = 0;
const lockWeek = 1;
const lockTwoWeeks = 2;

const programStart = Math.floor(Date.now() / 1000) + 10_000_000;
const programEnd = programStart + oneMonthSec;
const TOTAL_REWARDS = ether(oneMonthSec.toString());

export interface TestContext {
    admin: SignerWithAddress;
    connectUser: (signer: SignerWithAddress) => Promise<CellarStaking>;
    signers: SignerWithAddress[];
    staking: CellarStaking;
    stakingUser: CellarStaking;
    tokenDist: MockERC20;
    tokenStake: MockERC20;
    user: SignerWithAddress;
}

export interface Action {
    timestamp: number;
    actions: ActionInfo[];
}

export interface ActionInfo {
    signer: SignerWithAddress;
    amount: BigNumberish;
    action: "deposit" | "withdraw" | "unbond" | "claim";
    lock?: 0 | 1 | 2
}

export interface RewardInfo {
    signer: SignerWithAddress;
    expectedReward: BigNumberish;
}
export interface ScenarioInfo {
    actions: Action[];
    rewards: RewardInfo[];
}

/**
 * Deploy a contract with the given artifact name
 * Will be deployed by the given deployer address with the given params
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deploy<T extends Contract>(contractName: string, deployer: Signer, params: any[]): Promise<T> {
  const artifact: Artifact = await hre.artifacts.readArtifact(contractName);
  return <T>await deployContract(deployer, artifact, params);
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// TIME
export async function increaseTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

export async function setNextBlockTimestamp(epoch: number): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [epoch]);
  await ethers.provider.send("evm_mine", []);
}

export async function unbondUnstake(staking: CellarStaking, user: SignerWithAddress, depositId: number): Promise<void> {
  await staking.unbond(depositId);
  const stake = await staking.stakes(user.address, depositId);
  const unbondTimestamp = stake.unbondTimestamp.toNumber();

  await setNextBlockTimestamp(unbondTimestamp + 1);
  await staking.unstake(depositId);
}

export const expectRoundedEqual = (num: BigNumberish, target: BigNumberish, pctWithin = 1): void => {
    num = ethers.BigNumber.from(num);
    target = ethers.BigNumber.from(target);

    // Tolerable precision is 0.1%. Precision is lost in the magic mine in both
    // calculating NFT reward boosts and timing per second
    const precision = 100;
    const denom = ether("1").div(precision);

    if (target.eq(0)) {
        expect(num).to.be.lte(ether("1"));
    } else if (num.eq(0)) {
        expect(target).to.be.lte(ether("1"));
    } else {
        // Expect it to be less than 2% diff
        const lowerBound = target.div(denom).mul(denom.div(100).mul(100 - pctWithin));
        const upperBound = target.div(denom).mul(denom.div(100).mul(100 + pctWithin));

        expect(num).to.be.gte(lowerBound);
        expect(num).to.be.lte(upperBound);
    }
};

export const claimWithRoundedRewardCheck = async (
    staking: CellarStaking,
    user: SignerWithAddress,
    expectedReward: BigNumberish,
): Promise<ContractTransaction> => {
    const claimTx = await staking.connect(user).claimAll();
    const receipt = await claimTx.wait();

    // Cannot use expect matchers because of rounded equal comparison
    const claimEvents = receipt.events?.filter(e => e.event === "Claim");

    let reward = ethers.BigNumber.from(0);
    for (const event of claimEvents!) {
        expect(event).to.not.be.undefined;
        expect(event?.args?.[0]).to.eq(user.address);

        reward = reward.add(event?.args?.[2]);
    }

    expectRoundedEqual(reward, expectedReward);

    return claimTx;
};

export const fundAndApprove = async (ctx: TestContext): Promise<void> => {
    const {
        signers,
        tokenStake,
        staking
    } = ctx;

    const [...users] = signers.slice(1, 5);

    const stakerFunding = users.map(u => tokenStake.mint(u.address, ether("100000")));
    const stakerApprove = users.map(u => tokenStake.connect(u).approve(staking.address, ether("100000")));
    await Promise.all(stakerFunding.concat(stakerApprove));
}

export const setupAdvancedScenario1 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 1:
    // (Different stake times, all unbond + unstake after program end, same locks)
    //
    // Staker 1 Deposits N at 0 with one day lock
    // Staker 2 Deposits N/3 at 0.25 with one day lock
    // Staker 3 Deposits 2N/3 at 0.5 with one day lock
    // Staker 4 Deposits 2N at 0.75 with one day lock
    //
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:    100                 0               0               0
    // At T = 0.25:  75                25               0               0
    // At T = 0.5:   50             16.67           33.33               0
    // At T = 0.75:  25              8.33           16.67              50
    // Totals:      62.5             12.5            12.5             12.5
    // Total Deposits:

    const {
        signers: [, user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalTime = oneMonthSec;
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
        {
            timestamp: programStart + 5,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.25,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.div(3),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.5,
            actions: [
                {
                    signer: user3,
                    amount: baseAmount.div(3).mul(2),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.75,
            actions: [
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(6250),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(1250),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1250),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(1250),
        },
    ];

    return { actions, rewards };
};

export const setupAdvancedScenario2 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 2:
    // (Different stake times, all unbond + unstake after program end, different locks)
    //
    // Staker 1 Deposits N at 0 with two week lock (v = 2N)
    // Staker 2 Deposits N/3 at 0.25 with one day lock (v = .3667N)
    // Staker 3 Deposits 2N/3 at 0.5 with one week lock (v = .9333N)
    // Staker 4 Deposits 2N at 0.75 with one day lock (v = 2.2N)
    //
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:      100                 0               0               0
    // At T = 0.25:  84.5              15.5               0               0
    // At T = 0.5:   60.6             11.11           28.28               0
    // At T = 0.75: 36.36              6.67           16.97              40
    // Totals:      70.37              8.32           11.31              10
    // Total Deposits:

    const {
        signers: [, user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalTime = oneMonthSec;
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
        {
            timestamp: programStart + 5,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    lock: lockTwoWeeks
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.25,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.div(3),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.5,
            actions: [
                {
                    signer: user3,
                    amount: baseAmount.div(3).mul(2),
                    action: "deposit",
                    lock: lockWeek
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.75,
            actions: [
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(7037),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(832),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1131),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(1000),
        },
    ];

    return { actions, rewards };
};

export const setupAdvancedScenario3 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 3:
    // (Different stake times and locks, midstream unbonding and unstaking)
    //
    // Staker 1 Deposits N at 0 with two week lock (v = 2N)
    // Staker 2 Deposits 3N at 0 with one day lock (v = 3.3N)
    // Staker 3 Deposits 2N at 0.25 with one week lock (v = 2.8N)
    // Staker 2 Unbonds 3N at 0.25 (v = 3N)
    // Staker 4 Deposits 4N at 0.5 with two week lock (v = 8N)
    // Staker 3 Deposits 2N at 0.5 with one day lock (v = 2.2N)
    // Staker 2 Unstakes 3N at 0.75 (v = 0)
    // Staker 4 Unbonds 4N at 0.75 (v = 4N)
    //
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:     37.73            62.26               0               0
    // At T = 0.25:  25.64            38.46            35.9               0
    // At T = 0.5:   11.11            16.67           27.78           44.44
    // At T = 0.75:  18.18                0           45.45           36.36
    // Totals:       23.17            29.35           27.28            20.2
    // Total Deposits:

    const {
        signers: [, user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalTime = oneMonthSec;
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
        {
            timestamp: programStart + 5,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    lock: lockTwoWeeks
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    lock: lockDay
                }
            ],
        },
        {
            timestamp: programStart + totalTime * 0.25,
            actions: [
                {
                    signer: user3,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    lock: lockWeek
                },
                {
                    signer: user2,
                    amount: 0,
                    action: "unbond"
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.5,
            actions: [
                {
                    signer: user4,
                    amount: baseAmount.mul(4),
                    action: "deposit",
                    lock: lockTwoWeeks
                },
                {
                    signer: user3,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    lock: lockDay
                },
            ],
        },
        {
            timestamp: programStart + totalTime * 0.75,
            actions: [
                {
                    signer: user4,
                    amount: 0,
                    action: "unbond",
                },
                {
                    signer: user2,
                    amount: 0,
                    action: "withdraw"
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(2317),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(2935),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(2728),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(2020),
        },
    ];

    return { actions, rewards };
};


// export const setupAdvancedScenario3 = (ctx: TestContext): ScenarioInfo => {
//     // Advanced Scenario 3:
//     // (Same as scenario 2, with midstream claims)
//     //
//     // Staker 1 Deposits N at -1000
//     // Staker 1 Withdraws N at -500
//     // Staker 2 Deposits 3N at 0
//     // Staker 3 Deposits N at 0
//     // Staker 4 Deposits 9N at 0.25
//     // Staker 2 Withdraws 3N at 0.25
//     // Staker 1 Deposits 2N At 0.5
//     // Staker 4 Claims at 0.5
//     // Staker 2 Deposits 3N at 0.75
//     // Staker 1 Claims at 0.75

//     //
//     //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
//     // At T = -1000: 100                0               0               0
//     // At T = -500:    0                0               0               0
//     // At T = 0:       0               75              25               0
//     // At T = 0.25:    0                0              10              90
//     // At T = 0.5: 16.67                0            8.33              75
//     // At T = 0.75:13.33               20            6.67              60
//     // Totals:       7.5            23.75            12.5           56.25

//     const {
//         users: [user1, user2, user3, user4],
//         start,
//         end,
//     } = ctx;

//     const baseAmount = ether("100");
//     const totalTime = end - start;
//     const totalRewardsBase = TOTAL_REWARDS.div(10000);

//     const actions: Action[] = [
//         {
//             timestamp: start - ONE_DAY_SEC - 5_000_000,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                 },
//             ],
//         },
//         {
//             timestamp: start - ONE_DAY_SEC - 100_000,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: 0,
//                     action: "withdraw",
//                 },
//             ],
//         },
//         {
//             timestamp: start - ONE_DAY_SEC - 100,
//             actions: [
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                 },
//                 {
//                     signer: user3,
//                     amount: baseAmount,
//                     action: "deposit",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.25,
//             actions: [
//                 {
//                     signer: user4,
//                     amount: baseAmount.mul(9),
//                     action: "deposit",
//                 },
//                 {
//                     signer: user2,
//                     amount: 0,
//                     action: "withdraw",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.5,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                 },
//                 {
//                     signer: user4,
//                     amount: 0,
//                     action: "claim",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.75,
//             actions: [
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                 },
//                 {
//                     signer: user1,
//                     amount: 0,
//                     action: "claim",
//                 },
//             ],
//         },
//     ];

//     const rewards: RewardInfo[] = [
//         {
//             signer: user1,
//             expectedReward: totalRewardsBase.mul(750),
//         },
//         {
//             signer: user2,
//             expectedReward: totalRewardsBase.mul(2375),
//         },
//         {
//             signer: user3,
//             expectedReward: totalRewardsBase.mul(1250),
//         },
//         {
//             signer: user4,
//             expectedReward: totalRewardsBase.mul(5625),
//         },
//     ];

//     return { actions, rewards };
// };

// export const setupAdvancedScenario4 = (ctx: TestContext): ScenarioInfo => {
//     // Advanced Scenario :
//     // Multiple deposits for same user, midstream claims, with DAO fee of 4%
//     //
//     // Staker 1 Deposits N at 0
//     // Staker 2 Deposits 2N at 0
//     // Staker 1 Deposits N at 0.25
//     // Staker 3 Deposits 2N at 0.5
//     // Staker 2 Withdraws at 0.5
//     // Staker 1 Deposits N at 0.5
//     // Staker 4 Deposits 3N at 0.75
//     // Staker 1 Claims at 0.75
//     //
//     //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
//     // At T = 0:   33.33            66.67               0               0
//     // At T = 0.25:   50               50               0               0
//     // At T = 0.5:    60                0              40               0
//     // At T = 0.75: 37.5                0              25            37.5
//     // Totals:   45.2075          29.1667           16.25           9.375

//     const {
//         users: [user1, user2, user3, user4],
//         start,
//         end,
//     } = ctx;

//     const baseAmount = ether("100");
//     const totalTime = end - start;
//     const totalRewardsBase = TOTAL_REWARDS.div(1000000);

//     const actions: Action[] = [
//         {
//             timestamp: start - ONE_DAY_SEC - 100,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                 },
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.25,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.5,
//             actions: [
//                 {
//                     signer: user2,
//                     amount: 0,
//                     action: "withdraw",
//                 },
//                 {
//                     signer: user3,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                 },
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.75,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: 0,
//                     action: "claim",
//                 },
//                 {
//                     signer: user4,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                 },
//             ],
//         },
//     ];

//     const rewards: RewardInfo[] = [
//         {
//             signer: user1,
//             expectedReward: totalRewardsBase.mul(452075).div(100).mul(96),
//         },
//         {
//             signer: user2,
//             expectedReward: totalRewardsBase.mul(291667).div(100).mul(96),
//         },
//         {
//             signer: user3,
//             expectedReward: totalRewardsBase.mul(162500).div(100).mul(96),
//         },
//         {
//             signer: user4,
//             expectedReward: totalRewardsBase.mul(93750).div(100).mul(96),
//         },
//     ];

//     return { actions, rewards };
// };

// export const setupAdvancedScenario5 = (ctx: TestContext, stakers: [AtlasMineStaker, AtlasMineStaker]): ScenarioInfo => {
//     // Advanced Scenario 5:
//     // (Multiple deposits for same user, midstream claims, 2 stakers, one NFT boosted)
//     //
//     // Pool 1 - 1/1 Legion NFT for 2x boost, 210% boost total
//     // Staker 1 Deposits N at 0
//     // Staker 2 Deposits 2N at 0
//     // Staker 1 Deposits N at 0.25
//     // Staker 3 Deposits 2N at 0.5
//     // Staker 2 Withdraws 2N at 0.5
//     // Staker 1 Deposits N at 0.5
//     // Staker 4 Deposits 3N at 0.75
//     // Staker 1 Claims at 0.75
//     //
//     // Pool 2 - No NFT, 10% boost total
//     // Staker 2 Deposits 3N at 0
//     // Staker 3 Deposits N at 0
//     // Staker 4 Deposits 9N at 0.25
//     // Staker 2 Withdraws 3N at 0.25
//     // Staker 1 Deposits 2N At 0.5
//     // Staker 2 Deposits 3N at 0.75
//     // Staker 1 Claims at 0.75
//     //
//     // Pool 1:
//     //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
//     // At T = 0:   33.33            66.67               0               0
//     // At T = 0.25:   50               50               0               0
//     // At T = 0.5:    60                0              40               0
//     // At T = 0.75: 37.5                0              25            37.5
//     // Totals:   45.2075          29.1667           16.25           9.375
//     //
//     // Pool 2:
//     //
//     // At T = 0:       0               75              25               0
//     // At T = 0.25:    0                0              10              90
//     // At T = 0.5: 16.67                0            8.33              75
//     // At T = 0.75:13.33               20            6.67              60
//     // Totals:       7.5            23.75            12.5           56.25
//     //
//     // Combined (Per Pool - no Boosts):
//     // At T = 0:    42.86            57.14
//     // At T = 0.25: 28.57            71.43
//     // At T = 0.5:  29.41            70.58
//     // At T = 0.75: 34.78            65.22
//     // Total:       33.91            66.09
//     //
//     // Combined (Per Pool - with NFT boosts):
//     //            Pool 1 %        Pool 2 %
//     // At T = 0:       60               40
//     // At T = 0.25: 44.44            55.55
//     // At T = 0.5:  45.45            54.54
//     // At T = 0.75: 51.61            48.39
//     //
//     ///////////////// Combined (Per Pool - Adjusted for 10% Lock Boost to both pools):
//     /////////////////            Pool 1 %        Pool 2 %
//     ///////////////// At T = 0:    58.88            41.12
//     ///////////////// At T = 0.25: 43.30            56.70
//     ///////////////// At T = 0.5:  44.30            55.70
//     ///////////////// At T = 0.75: 50.45            49.55
//     ///////////////// Total:       49.23            50.77
//     //
//     // Combined (Per User):
//     //            Staker 1 %     Staker 2 %      Staker 3 %      Staker 4 %
//     // At T = 0:     19.62             70.1           10.28               0
//     // At T = 0.25:  21.65            21.65            5.67           51.03
//     // At T = 0.5:   35.87                0           22.36           41.78
//     // At T = 0.75:  25.52             9.91           15.92           48.65
//     // Totals:      25.665           25.415         13.5575          35.365

//     const {
//         users: [user1, user2, user3, user4],
//         start,
//         end,
//     } = ctx;

//     const baseAmount = ether("100");
//     const totalTime = end - start;
//     const totalRewardsBase = TOTAL_REWARDS.div(1000000);

//     const actions: Action[] = [
//         {
//             timestamp: start - ONE_DAY_SEC - 100,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                     staker: stakers[1],
//                 },
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user3,
//                     amount: baseAmount,
//                     action: "deposit",
//                     staker: stakers[1],
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.25,
//             actions: [
//                 {
//                     signer: user4,
//                     amount: baseAmount.mul(9),
//                     action: "deposit",
//                     staker: stakers[1],
//                 },
//                 {
//                     signer: user2,
//                     amount: 0,
//                     action: "withdraw",
//                     staker: stakers[1],
//                 },
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.5,
//             actions: [
//                 {
//                     signer: user2,
//                     amount: 0,
//                     action: "withdraw",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user3,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user1,
//                     amount: baseAmount,
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user1,
//                     amount: baseAmount.mul(2),
//                     action: "deposit",
//                     staker: stakers[1],
//                 },
//             ],
//         },
//         {
//             timestamp: start + totalTime * 0.75,
//             actions: [
//                 {
//                     signer: user1,
//                     amount: 0,
//                     action: "claim",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user4,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                     staker: stakers[0],
//                 },
//                 {
//                     signer: user2,
//                     amount: baseAmount.mul(3),
//                     action: "deposit",
//                     staker: stakers[1],
//                 },
//             ],
//         },
//     ];

//     const combinedRewards: RewardInfo[] = [
//         {
//             signer: user1,
//             expectedReward: totalRewardsBase.mul(256650),
//         },
//         {
//             signer: user2,
//             expectedReward: totalRewardsBase.mul(254150),
//         },
//         {
//             signer: user3,
//             expectedReward: totalRewardsBase.mul(135575),
//         },
//         {
//             signer: user4,
//             expectedReward: totalRewardsBase.mul(353650),
//         },
//     ];

//     return {
//         actions,
//         rewards: combinedRewards,
//     };
// };

export const runScenario = async (
    ctx: TestContext,
    actions: Action[],
    logCheckpoints = false,
): Promise<{ [user: string]: BigNumberish }> => {
    const { staking, signers } = ctx;
    const claims: { [user: string]: BigNumberish } = {};

    let haveNotified = false;

    await staking.setRewardsDuration(oneMonthSec);

    const doNotify = async () => {
        if (haveNotified) return;

        await setNextBlockTimestamp(programStart);
        await staking.notifyRewardAmount(TOTAL_REWARDS);
        haveNotified = true;
    }

    // Run through scenario from beginning of program until end
    for (const batch of actions) {
        const { timestamp, actions: batchActions } = batch;

        // Make deposit
        if (timestamp > programStart) {
            await doNotify();
        }

        await setNextBlockTimestamp(timestamp);

        let tx: ContractTransaction;

        for (const a of batchActions) {
            const { signer, amount, action, lock } = a;

            if (action === "deposit") {
                tx = await staking.connect(signer).stake(amount, lock!);
            } else if (action === "claim") {
                // No need to roll, just claim - keep track of amount rewarded
                tx = await staking.connect(signer).claimAll();
                const receipt = await tx.wait();

                const claimEvents = receipt.events?.filter(e => e.event === "Claim");

                let reward = ethers.BigNumber.from(0);
                for (const event of claimEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);

                    reward = reward.add(event?.args?.[2]);
                }

                if (claims[signer.address]) {
                    claims[signer.address] = ethers.BigNumber.from(claims[signer.address]).add(reward);
                } else {
                    claims[signer.address] = reward;
                }
            } else if (action === "unbond") {
                // No need to roll, just claim - keep track of amount rewarded
                tx = await staking.connect(signer).unbondAll();
                await tx.wait();
            } else if (action === "withdraw") {
                // No need to roll, just claim - keep track of amount rewarded
                tx = await staking.connect(signer).unstakeAll();
                const receipt = await tx.wait();

                const withdrawEvents = receipt.events?.filter(e => e.event === "Unstake");

                let reward = ethers.BigNumber.from(0);
                for (const event of withdrawEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);

                    reward = reward.add(event?.args?.[3]);
                }

                if (claims[signer.address]) {
                    claims[signer.address] = ethers.BigNumber.from(claims[signer.address]).add(reward);
                } else {
                    claims[signer.address] = reward;
                }
            }
        }

        await tx!.wait();

        // Actions for timestamp done

        if (logCheckpoints) {
            // Report balances for all coins
            const { staking, tokenDist } = ctx;

            console.log("Timestamp:", timestamp);
            console.log("Total Staked:", await (await staking.totalDeposits()).toString());
            console.log("Total Staked With Boost:", await (await staking.totalDepositsWithBoost()).toString());
            console.log("Balances");
            for (const user of signers.slice(1, 5)) {
                console.log(`Wallet balance (${user.address}): ${await tokenDist.balanceOf(user.address)}`);
            }
            console.log();
        }
    }

    // Now roll to end - all staking should be processed
    await setNextBlockTimestamp(programEnd);

    return claims;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const shuffle = (array: any[]) => {
    let currentIndex = array.length,
        randomIndex;

    // While there remain elements to shuffle...
    while (currentIndex != 0) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
};