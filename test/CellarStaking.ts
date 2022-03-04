import { BigNumber } from "ethers";
import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import type { CellarStaking } from "../src/types/CellarStaking";
import type { MockERC20 } from "../src/types/MockERC20";
import { deploy, increaseTime, rand, setNextBlockTimestamp, rollNextEpoch } from "./utils";

interface TestContext {
  admin: SignerWithAddress;
  connectUser: (signer: SignerWithAddress) => Promise<CellarStaking>;
  maxEpochs: number;
  signers: SignerWithAddress[];
  staking: CellarStaking;
  stakingUser: CellarStaking;
  tokenDist: MockERC20;
  tokenStake: MockERC20;
  user: SignerWithAddress;
}

const oneDaySec = 60 * 60 * 24;
const oneWeekSec = oneDaySec * 7;
const hundred = BigNumber.from(100);

describe("CellarStaking", () => {
  let ctx: TestContext;
  const initialTokenAmount = 20000000; // 20M
  const initialBN = BigNumber.from(initialTokenAmount);
  let startTimestamp: number;

  // Lock enum
  const lockDay = 0;
  const lockWeek = 1;
  const lockTwoWeeks = 2;

  const fixture = async (): Promise<TestContext> => {
    // Signers
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const admin = signers[0];
    const user = signers[1];

    // Bootstrap staking and distribution tokens
    const tokenStake = <MockERC20>await deploy("MockERC20", admin, ["staking", "stk"]);
    await tokenStake.mint(user.address, initialTokenAmount);

    const tokenDist = <MockERC20>await deploy("MockERC20", admin, ["distribution", "dist"]);
    await tokenDist.mint(admin.address, initialTokenAmount);

    // Bootstrap CellarStaking contract
    const maxEpochs = 3;
    const params = [admin.address, tokenStake.address, tokenDist.address, maxEpochs];
    const staking = <CellarStaking>await deploy("CellarStaking", admin, params);
    const stakingUser = await staking.connect(user);

    // Allow staking contract to transfer rewardsfor distribution
    await tokenDist.increaseAllowance(staking.address, initialTokenAmount);

    // Allow staking contract to transfer on behalf of user
    const tokenStakeUser = await tokenStake.connect(user);
    await tokenStakeUser.increaseAllowance(staking.address, initialTokenAmount);

    const connectUser = async (signer: SignerWithAddress): Promise<CellarStaking> => {
      const stake = await tokenStake.connect(signer);
      await stake.mint(signer.address, initialTokenAmount);
      await stake.increaseAllowance(staking.address, initialTokenAmount);

      return staking.connect(signer);
    };

    return {
      admin,
      connectUser,
      maxEpochs,
      signers,
      staking,
      stakingUser,
      tokenDist,
      tokenStake,
      user,
    };
  };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
  });

  describe("User Operations", () => {
    describe("stake, uninitialized", () => {
      it("should not allow staking if the rewards are not initialized", async () => {
        const { stakingUser } = ctx;

        await expect(stakingUser.stake(1000, lockDay)).to.be.revertedWith("STATE_ContractPaused");
      });
    });

    describe("stake, initialized to one wei per epoch sec", () => {
      beforeEach(async () => {
        await ctx.staking.initializePool(1, oneDaySec);
      });

      it("should not allow a user to stake if the stake is under the minimum", async () => {
        const { staking, stakingUser } = ctx;
        const min = 100;
        await staking.updateMinimumDeposit(min);

        await expect(stakingUser.stake(min - 1, lockDay)).to.be.revertedWith("USR_MinimumDeposit");
      });

      it("should not allow a user to stake if there are no rewards left", async () => {
        const { stakingUser } = ctx;
        await increaseTime(oneDaySec * 2); // epoch has not completed

        await expect(stakingUser.stake(1, lockDay)).to.be.revertedWith("STATE_NoRewardsLeft");
      });

      it("should not allow a user to stake if the amount is zero", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.stake(0, lockDay)).to.be.revertedWith("USR_StakeTooSmall");
      });

      it.skip("should not allow a user to stake if their stake is too small to receive a share", async () => {
        const { connectUser, signers, stakingUser } = ctx;

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(1, lockTwoWeeks);

        await stakingUser.stake(initialTokenAmount, lockWeek);
        await stakingUser2.stake(1, lockTwoWeeks);

        //await expect(stakingUser.stake(0, lockDay)).to.be.revertedWith("USR_StakeTooSmall");
      });

      it("should revert for an invalid lock value", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.stake(1, 99)).to.be.revertedWith("function was called with incorrect parameter");
      });

      it("should allow one user to stake with 100% proportional share", async () => {
        const { stakingUser, user } = ctx;
        await stakingUser.stake(100000, lockDay);

        const stakes = await stakingUser.stakes(user.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber());
      });

      it("should allow two users to stake with an even proportional share", async () => {
        const { connectUser, signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount, lockDay);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount, lockDay);

        const stakes = await stakingUser.stakes(user.address, 0);
        const stakes2 = await stakingUser.stakes(user2.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber() / 2);
        expect(stakes.shares.toNumber()).to.equal(stakes2.shares.toNumber());
      });

      it("should allow three users to stake with an even proportional share", async () => {
        const { connectUser, signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount, lockDay);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount, lockDay);

        const user3 = signers[3];
        const stakingUser3 = await connectUser(user3);
        await stakingUser3.stake(amount, lockDay);

        const stakes = await stakingUser.stakes(user.address, 0);
        const stakes2 = await stakingUser.stakes(user2.address, 0);
        const stakes3 = await stakingUser.stakes(user3.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(stakes2.shares.toNumber());
        expect(stakes.shares.toNumber()).to.equal(stakes3.shares.toNumber());
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber() / 3);
      });

      it("should correctly calculate shares for a 60/40 stake between two users", async () => {
        const x = 0.6;
        const y = 0.4;
        const { connectUser, signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount * x, lockDay);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount * y, lockDay);

        const stakes = await stakingUser.stakes(user.address, 0);
        const stakes2 = await stakingUser.stakes(user2.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber() * x);
        expect(stakes2.shares.toNumber()).to.equal(totalShares.toNumber() * y);
      });

      it.skip("should correctly calculate stake shares for two users", async () => {
        // number of runs
        const times = 10;

        for (let i = 0; i < times; i++) {
          ctx = await loadFixture(fixture);
          await ctx.staking.initializePool(1, oneDaySec);
          const { connectUser, signers, stakingUser, user } = ctx;

          // javascript floating point arithmetic is imprecise
          // user1 stakes x (x is a range 50-100 inclusive)
          // user2 stakes 100 - x
          const x = BigNumber.from(rand(50, 99));
          const amount1 = initialBN.mul(x).div(hundred).toNumber();
          const amount2 = initialTokenAmount - amount1;

          await stakingUser.stake(amount1, lockDay);

          const user2 = signers[2];
          const stakingUser2 = await connectUser(user2);
          await stakingUser2.stake(amount2, lockDay);

          const shares1 = (await stakingUser.stakes(user.address, 0)).shares;
          const shares2 = (await stakingUser.stakes(user2.address, 0)).shares;
          const totalShares = await stakingUser.totalShares();

          const expected1 = shares1.mul(initialBN).div(totalShares).toNumber();
          const expected2 = shares2.mul(initialBN).div(totalShares).toNumber();
          expect(expected1).to.equal(amount1);
          expect(expected2).to.equal(amount2);
        }
      });

      it.skip("fuzzing with random number of users and staked amounts", async () => {
        // global fuzzing parameters
        const times = 1;
        const minStake = 100; //100000
        const maxStake = 10000; //initialTokenAmount

        for (let i = 0; i < times; i++) {
          // reset fixture
          ctx = await loadFixture(fixture);
          await ctx.staking.initializePool(1, oneDaySec);
          const { connectUser } = ctx;

          // setup fuzzing scenario
          const numUsers = rand(2, 19); // Max signers = 10 because 0 is admin
          const signers = <SignerWithAddress[]>[...Array(numUsers).keys()].map(i => ctx.signers[i + 1]);
          const amounts = new Map<SignerWithAddress, number>();
          let totalStaked = BigNumber.from(0);

          // stake a random amount for each signer
          for (const signer of signers) {
            const staking = await connectUser(signer);
            const amount = rand(minStake, maxStake); // inclusive
            await staking.stake(amount, lockDay);

            amounts.set(signer, amount);
            totalStaked = totalStaked.add(BigNumber.from(amount));
          }

          const totalShares = await ctx.staking.totalShares();
          console.log(`Number of users: ${numUsers}`);
          console.log(`Total amount staked: ${totalStaked.toNumber()}`);
          console.log(`totalShares: ${totalShares.toNumber()}`);

          for (const signer of signers) {
            const amount = amounts.get(signer);
            console.log(`User ${signer.address} staked: ${amount}`);

            const share = (await ctx.staking.stakes(signer.address, 0)).shares;
            console.log(`User ${signer.address} shares: ${share}`);

            // shares * totalStaked / totalShares = stakedAmount
            const expected = share.mul(totalStaked).div(totalShares).toNumber();
            expect(expected).to.equal(amount);
          }
        }
      });

      it("should properly calculate a user's proportional share with one day boost", async () => {
        const { connectUser, signers, stakingUser } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user 2 stakes 50, should get 55 shares with a 10% boost
        await stakingUser2.stake(50, lockDay);
        const stakes2 = await stakingUser2.stakes(user2.address, 0);

        const expected2 = 55;
        let totalShares = await stakingUser.totalShares();
        expect(stakes2.shares.toNumber()).to.equal(expected2);
        expect(totalShares.toNumber()).to.equal(expected2);

        // user 1 stakes 100, should get 110 shares
        await stakingUser.stake(100, lockDay);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 110;
        totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(expected);
        expect(totalShares.toNumber()).to.equal(expected + expected2);

        // user 2 stakes again, 99. should get 108 shares
        await stakingUser2.stake(99, lockDay);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 108; // 99 * 1.1
        totalShares = await stakingUser.totalShares();
        expect(stakes3.shares.toNumber()).to.equal(expected3);
        expect(totalShares.toNumber()).to.equal(expected + expected2 + expected3);
      });

      it("should properly calculate a user's proportional share with one week boost", async () => {
        const { connectUser, signers, stakingUser } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user 2 stakes 50, should get 70 shares with a 40% boost
        await stakingUser2.stake(50, lockWeek);
        const stakes2 = await stakingUser2.stakes(user2.address, 0);

        const expected2 = 70; // 50 * 1.4
        let totalShares = await stakingUser.totalShares();
        expect(stakes2.shares.toNumber()).to.equal(expected2);
        expect(totalShares.toNumber()).to.equal(expected2);

        // user 1 stakes 100, should get 140 shares
        await stakingUser.stake(100, lockWeek);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 140;
        totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(expected);
        expect(totalShares.toNumber()).to.equal(expected + expected2);

        // user 2 stakes again, 297. should get 415 shares due to rounding down
        await stakingUser2.stake(297, lockWeek);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 415; // 297 * 1.4 floored
        totalShares = await stakingUser.totalShares();
        expect(stakes3.shares.toNumber()).to.equal(expected3);
        expect(totalShares.toNumber()).to.equal(expected + expected2 + expected3);
      });

      it("should properly calculate a user's proportional share with two week boost", async () => {
        const { connectUser, signers, stakingUser } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user 2 stakes 88, should get 176 shares with a 100% boost
        await stakingUser2.stake(88, lockTwoWeeks);
        const stakes2 = await stakingUser2.stakes(user2.address, 0);

        const expected2 = 176;
        let totalShares = await stakingUser.totalShares();
        expect(stakes2.shares.toNumber()).to.equal(expected2);
        expect(totalShares.toNumber()).to.equal(expected2);

        // user 1 stakes 100, should get 482 shares
        await stakingUser.stake(241, lockTwoWeeks);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 482;
        totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(expected);
        expect(totalShares.toNumber()).to.equal(expected + expected2);

        // user 2 stakes again, 832. should get 1664 shares
        await stakingUser2.stake(832, lockTwoWeeks);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 1664;
        totalShares = await stakingUser.totalShares();
        expect(stakes3.shares.toNumber()).to.equal(expected3);
        expect(totalShares.toNumber()).to.equal(expected + expected2 + expected3);
      });
    });

    describe("unstake", () => {
      describe("uninitialized", async () => {
        it("should not allow unstaking if the rewards are not initialized", async () => {
          const { stakingUser } = ctx;
          await expect(stakingUser.unstake(0)).to.be.revertedWith("STATE_ContractPaused");
        });
      });

      describe("initialized", () => {
        const rewardPerEpoch = oneWeekSec;
        const stakeAmount = 1000;
        const stakeAmountBN = BigNumber.from(stakeAmount);

        beforeEach(async () => {
          await ctx.staking.initializePool(1, oneWeekSec);
          await ctx.staking.replenishPool(1, oneWeekSec);

          await ctx.stakingUser.stake(stakeAmount, lockDay);
        });

        it("should revert if passed an out of bounds deposit id", async () => {
          const { stakingUser } = ctx;
          await expect(stakingUser.unstake(99)).to.be.revertedWith("USR_NoDeposit");
        });

        it("should not allow unstaking a stake that is still locked", async () => {
          const { stakingUser } = ctx;
          await expect(stakingUser.unstake(0)).to.be.revertedWith("USR_StakeLocked");
        });

        it("should require a non-zero amount to unstake", async () => {
          const { stakingUser, user, tokenDist } = ctx;

          await rollNextEpoch(stakingUser);
          await stakingUser.unbond(0);

          const prevBal = await tokenDist.balanceOf(user.address);

          const stake = await stakingUser.stakes(user.address, 0);
          await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

          await stakingUser.unstake(0);

          // single staker takes all rewards
          const bal = await tokenDist.balanceOf(user.address);
          expect(bal.sub(prevBal).toNumber()).to.equal(rewardPerEpoch);
        });

        it("should not unstake more than the deposited amount", async () => {
          const { stakingUser, user, tokenStake } = ctx;

          await rollNextEpoch(stakingUser);
          await stakingUser.unbond(0);

          const prevBal = await tokenStake.balanceOf(user.address);

          const stake = await stakingUser.stakes(user.address, 0);
          await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

          await stakingUser.unstake(0);

          // previous bal + staked amount should equal current balance
          const bal = await tokenStake.balanceOf(user.address);
          expect(prevBal.add(stakeAmountBN).toNumber()).to.equal(bal.toNumber());
        });

        it("should not allow a user to unstake an amount smaller than the unit share size"); // @kvk does this test make sense still?
        it("should unstake, distributing both the specified deposit amount and any accumulated rewards");
      });
    });

    describe("unstakeAll", () => {
      const rewardPerEpoch = 2000000; // 2M
      const stakeAmount = 50000;

      beforeEach(async () => {
        await ctx.staking.initializePool(1, oneWeekSec);
        await ctx.staking.replenishPool(1, oneWeekSec);
        await ctx.staking.replenishPool(1, oneWeekSec);
        await ctx.stakingUser.stake(stakeAmount, lockDay);
      });

      it("should unstake all amounts for all deposits, and distribute all available rewards", async () => {
        const { connectUser, signers, stakingUser, user, tokenDist, tokenStake } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user1 should collect all of first epoch reward
        await rollNextEpoch(stakingUser);

        // epoch 2 reward should be split 2/3 to 1/3
        await stakingUser2.stake(stakeAmount, lockDay);
        await stakingUser.stake(stakeAmount, lockDay);

        await rollNextEpoch(stakingUser);
        await stakingUser.unbondAll();

        const prevStakeBal = await tokenStake.balanceOf(user.address);
        const prevDistBal = await tokenDist.balanceOf(user.address);

        const stake = await stakingUser.stakes(user.address, 0);
        await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);
        await stakingUser.unstakeAll();

        // expect to recover balance that was initially staked
        const totalStaked = stakeAmount + stakeAmount;
        const stakeBal = await tokenStake.balanceOf(user.address);
        expect(prevStakeBal.add(BigNumber.from(totalStaked))).to.equal(stakeBal);

        // expect to collect all rewards of first epoch and 2/3 of 2nd epoch
        const expectedRewards = rewardPerEpoch + Math.floor((rewardPerEpoch * 2) / 3);
        const distBal = await tokenDist.balanceOf(user.address);
        expect(distBal.sub(prevDistBal)).to.equal(expectedRewards);
      });
    });

    describe.skip("claim", () => {
      describe("uninitialized", () => {
        it("should not allow claiming if the rewards are not initialized");
      });

      describe("initialized", () => {
        const rewardPerEpoch = oneWeekSec;
        const stakeAmount = 1000;
        const stakeAmountBN = BigNumber.from(stakeAmount);

        beforeEach(async () => {
          await ctx.staking.initializePool(1, oneWeekSec);
          await ctx.staking.replenishPool(1, oneWeekSec);
          await ctx.stakingUser.stake(stakeAmount, lockDay);
        });

        it("claim available rewards for a given deposit");
        it("should correctly calculate rewards for two claims within the same epoch");
        it("should correctly calculate rewards across multiple epochs");
        it("should corretctly calculate proportional rewards across different user's stakes, in the same epoch");
        it(
          "should correctly calculate proportional rewards for different user stakes, deposited during different epochs",
        );
        it("should not redistribute rewards tha have already been claimed");
      });
    });

    describe("claimAll", () => {
      it("should claim all available rewards for all deposits, within the same epoch");
      it("should claim all available rewards for all deposits, across multiple epochs");
    });

    describe("emergencyUnstake", () => {
      beforeEach(async () => {
        await ctx.staking.initializePool(1, oneWeekSec);
      });

      it("should revert if the staking program has not been ended", async () => {
        const { stakingUser } = ctx;

        await expect(stakingUser.emergencyUnstake()).to.be.revertedWith("STATE_NoEmergencyUnstake");
      });

      it("should return all staked tokens, across multiple stakes, regardless of lock status", async () => {
        const { connectUser, signers, staking, stakingUser, tokenStake, user } = ctx;
        await stakingUser.stake(initialTokenAmount, lockDay);
        expect(await tokenStake.balanceOf(user.address)).to.equal(0);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(initialTokenAmount, lockWeek);
        expect(await tokenStake.balanceOf(user2.address)).to.equal(0);

        const user3 = signers[3];
        const stakingUser3 = await connectUser(user3);
        await stakingUser3.stake(initialTokenAmount, lockTwoWeeks);
        expect(await tokenStake.balanceOf(user3.address)).to.equal(0);

        await staking.emergencyStop(false);
        await stakingUser.emergencyUnstake();
        expect(await tokenStake.balanceOf(user.address)).to.equal(initialTokenAmount);

        await stakingUser2.emergencyUnstake();
        expect(await tokenStake.balanceOf(user2.address)).to.equal(initialTokenAmount);

        await stakingUser3.emergencyUnstake();
        expect(await tokenStake.balanceOf(user3.address)).to.equal(initialTokenAmount);
      });

      it("should allow rewards to be claimable");
    });

    describe("emergencyClaim", () => {
      it("should revert if the staking program has not been ended", async () => {
        const { stakingUser } = ctx;

        await expect(stakingUser.emergencyClaim()).to.be.revertedWith("STATE_NoEmergencyUnstake");
      });

      it("should revert if the contract stopped with claim disabled", async () => {
        const { staking, stakingUser } = ctx;

        await staking.emergencyStop(false);
        await expect(stakingUser.emergencyClaim()).to.be.revertedWith("STATE_NoEmergencyClaim");
      });

      it("should return all staked tokens and distribute all unclaimed rewards");
    });
  });

  // describe("Admin Operations", () => {
  //   describe("initializePool", () => {
  //     it("should revert if caller is not the owner");
  //     it("should revert if the contract is paused");
  //     it("should revert if the staking pool has previously been initialized");
  //     it("should revert if the number of epochs is 0");
  //     it("should revert if the number of epochs is more than the maximum");
  //     it("should revert if the epoch length is 0");
  //     it("should revert if the rewards per epoch is 0");
  //     it("should revert if the owner cannot fund the reward epochs");
  //     it("should create new reward epochs and store them in contract state");
  //   });
  //
  //   describe("replenishPool", () => {
  //     it("should revert if caller is not the owner");
  //     it("should revert if the contract is paused");
  //     it("should revert if the staking pool has not previously been initialized");
  //     it("should revert if the number of new epochs is 0");
  //     it("should revert if the number of new epochs plus previous epochs is more than the maximum");
  //     it("should revert if the epoch length is 0");
  //     it("should revert if the rewards per epoch is 0");
  //     it("should revert if the owner cannot fund the new reward epochs");
  //     it("should create new reward epochs and store them in contract state, appending to existing state");
  //   });
  //
  //   describe("updateMinimumDeposit", () => {
  //     it("should revert if caller is not the owner");
  //     it("should set a new minimum staking deposit and immediately enforce it");
  //   });
  //
  //   describe("setPaused", () => {
  //     it("should revert if caller is not the owner");
  //     it("should pause the contract");
  //     it("should unpause the contract");
  //   });
  //
  //   describe("emergencyStop", () => {
  //     it("should revert if caller is not the owner");
  //     it("should end the contract while making rewards claimable");
  //     it("should end the contract and return distribution tokens if rewards are not claimable");
  //     it("should revert if called more than once");
  //   });
  // });
  //
  // describe("State Information", () => {
  //   describe("currentEpoch", () => {
  //     it("should report the correct epoch for the current time");
  //     it("should revert if there is no active epoch");
  //   });
  //
  //   describe("epochAtTime", () => {
  //     it("should report the correct epoch for the specified time");
  //     it("should revert if there is no active epoch at the time specified");
  //   });
  //
  //   describe("totalRewards", () => {
  //     it("should report the total rewards scheduled across all epochs");
  //   });
  //   });
});
