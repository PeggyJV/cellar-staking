import { BigNumber } from "ethers";
import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import type { CellarStaking } from "../src/types/CellarStaking";
import type { MockERC20 } from "../src/types/MockERC20";
import { ether, deploy, increaseTime, rand, setNextBlockTimestamp, expectRoundedEqual } from "./utils";

interface TestContext {
  admin: SignerWithAddress;
  connectUser: (signer: SignerWithAddress) => Promise<CellarStaking>;
  signers: SignerWithAddress[];
  staking: CellarStaking;
  stakingUser: CellarStaking;
  tokenDist: MockERC20;
  tokenStake: MockERC20;
  user: SignerWithAddress;
}

const oneDaySec = 60 * 60 * 24;
const oneWeekSec = oneDaySec * 7;
const oneMonthSec = oneDaySec * 30;

describe("CellarStaking", () => {
  let ctx: TestContext;
  const initialTokenAmount = ether("20000000"); // 20M
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
    const params = [admin.address, admin.address, tokenStake.address, tokenDist.address, oneMonthSec];
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
    describe("stake, initialized to one wei per epoch sec", () => {
      beforeEach(async () => {
        await ctx.staking.notifyRewardAmount(oneMonthSec);
      });

      it("should not allow a user to stake if the stake is under the minimum", async () => {
        const { staking, stakingUser } = ctx;
        const min = ether("100");
        await staking.updateMinimumDeposit(min);

        await expect(stakingUser.stake(min.sub(ether("1")), lockDay)).to.be.revertedWith("USR_MinimumDeposit");
      });

      it("should not allow a user to stake if there are no rewards left", async () => {
        const { stakingUser } = ctx;
        await increaseTime(oneMonthSec * 2); // epoch has not completed

        await expect(stakingUser.stake(ether("1"), lockDay)).to.be.revertedWith("STATE_NoRewardsLeft");
      });

      it("should not allow a user to stake if the amount is zero", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.stake(0, lockDay)).to.be.revertedWith("USR_ZeroDeposit");
      });

      it("should revert for an invalid lock value", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.stake(ether("1"), 99)).to.be.revertedWith("function was called with incorrect parameter");
      });

      it("should allow one user to stake with 100% proportional share", async () => {
        const { stakingUser, user } = ctx;
        const stakeAmount = ether("100000");

        await expect(stakingUser.stake(stakeAmount, lockDay))
          .to.emit(stakingUser, "Stake")
          .withArgs(user.address, 0, stakeAmount);

        const stake = await stakingUser.stakes(user.address, 0);
        const totalDeposits = await stakingUser.totalDeposits();
        const totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        const rewardPerTokenStored = await stakingUser.rewardPerTokenStored();

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amount).to.equal(totalDeposits);
        expect(stake.amountWithBoost).to.equal(totalDepositsWithBoost);
        expect(stake.rewardPerTokenPaid).to.equal(rewardPerTokenStored);
        expect(stake.rewards).to.equal(0);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockDay);
      });

      it("should calculate the correct boosts for different lock times", async () => {
        const { stakingUser, user } = ctx;
        const stakeAmount = ether("100000");

        await expect(stakingUser.stake(stakeAmount, lockDay)).to.not.be.reverted;
        await expect(stakingUser.stake(stakeAmount, lockWeek)).to.not.be.reverted;
        await expect(stakingUser.stake(stakeAmount, lockTwoWeeks)).to.not.be.reverted;

        let stake = await stakingUser.stakes(user.address, 0);
        let boostMultiplier = stakeAmount.mul(await stakingUser.ONE_DAY_BOOST()).div(ether("1"));
        let expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);

        stake = await stakingUser.stakes(user.address, 1);
        boostMultiplier = stakeAmount.mul(await stakingUser.ONE_WEEK_BOOST()).div(ether("1"));
        expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);

        stake = await stakingUser.stakes(user.address, 2);
        boostMultiplier = stakeAmount.mul(await stakingUser.TWO_WEEKS_BOOST()).div(ether("1"));
        expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
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

        const totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(totalDepositsWithBoost.div(2));
        expect(stakes.amountWithBoost).to.equal(stakes2.amountWithBoost);
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

        const totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(totalDepositsWithBoost.div(3));
        expect(stakes.amountWithBoost).to.equal(stakes2.amountWithBoost);
        expect(stakes.amountWithBoost).to.equal(stakes3.amountWithBoost);
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
        const totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(totalDepositsWithBoost.div(10).mul(x * 10));
        expect(stakes2.amountWithBoost).to.equal(totalDepositsWithBoost.div(10).mul(y * 10));
      });

      it("should correctly calculate stake shares for two users", async () => {
        // number of runs
        const times = 10;

        for (let i = 0; i < times; i++) {
          ctx = await loadFixture(fixture);
          await ctx.staking.setRewardsDuration(oneDaySec);
          await ctx.staking.notifyRewardAmount(oneDaySec);
          const { connectUser, signers, stakingUser, user } = ctx;

          // javascript floating point arithmetic is imprecise
          // user1 stakes x (x is a range 50-100 inclusive)
          // user2 stakes 100 - x
          const x = rand(50, 99);
          const amount1 = initialTokenAmount.div(100).mul(x);
          const amount2 = initialTokenAmount.sub(amount1);

          await stakingUser.stake(amount1, lockDay);

          const user2 = signers[2];
          const stakingUser2 = await connectUser(user2);
          await stakingUser2.stake(amount2, lockDay);

          const stakes1 = (await stakingUser.stakes(user.address, 0)).amountWithBoost;
          const stakes2 = (await stakingUser.stakes(user2.address, 0)).amountWithBoost;
          const totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();

          const expected1 = stakes1.mul(initialTokenAmount).div(totalDepositsWithBoost);
          const expected2 = stakes2.mul(initialTokenAmount).div(totalDepositsWithBoost);
          expect(expected1).to.equal(amount1);
          expect(expected2).to.equal(amount2);
        }
      });

      it("fuzzing with random number of users and staked amounts", async () => {
        // global fuzzing parameters
        const times = 1;
        const minStake = 100; //100000
        const maxStake = 10000; //initialTokenAmount

        for (let i = 0; i < times; i++) {
          // reset fixture
          ctx = await loadFixture(fixture);
          await ctx.staking.setRewardsDuration(oneDaySec);
          await ctx.staking.notifyRewardAmount(oneDaySec);
          const { connectUser } = ctx;

          // setup fuzzing scenario
          const numUsers = rand(2, 19); // Max signers = 10 because 0 is admin
          const signers = <SignerWithAddress[]>[...Array(numUsers).keys()].map(i => ctx.signers[i + 1]);
          const amounts = new Map<SignerWithAddress, BigNumber>();
          let totalStaked = BigNumber.from(0);

          // stake a random amount for each signer
          for (const signer of signers) {
            const staking = await connectUser(signer);
            const amount = ethers.utils.parseEther(rand(minStake, maxStake).toString()); // inclusive
            await staking.stake(amount, lockDay);

            amounts.set(signer, amount);
            totalStaked = totalStaked.add(BigNumber.from(amount));
          }

          const totalDepositsWithBoost = await ctx.staking.totalDepositsWithBoost();

          for (const signer of signers) {
            const amount = amounts.get(signer);
            const share = (await ctx.staking.stakes(signer.address, 0)).amountWithBoost;

            // shares * totalStaked / totalShares = stakedAmount
            const expected = share.mul(totalStaked).div(totalDepositsWithBoost);
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
        let totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes2.amountWithBoost).to.equal(expected2);
        expect(totalDepositsWithBoost).to.equal(expected2);

        // user 1 stakes 100, should get 110 shares
        await stakingUser.stake(100, lockDay);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 110;
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(expected);
        expect(totalDepositsWithBoost).to.equal(expected + expected2);

        // user 2 stakes again, 99. should get 108 shares
        await stakingUser2.stake(99, lockDay);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 108; // 99 * 1.1
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes3.amountWithBoost).to.equal(expected3);
        expect(totalDepositsWithBoost).to.equal(expected + expected2 + expected3);
      });

      it("should properly calculate a user's proportional share with one week boost", async () => {
        const { connectUser, signers, stakingUser } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user 2 stakes 50, should get 70 shares with a 40% boost
        await stakingUser2.stake(50, lockWeek);
        const stakes2 = await stakingUser2.stakes(user2.address, 0);

        const expected2 = 70; // 50 * 1.4
        let totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes2.amountWithBoost).to.equal(expected2);
        expect(totalDepositsWithBoost).to.equal(expected2);

        // user 1 stakes 100, should get 140 shares
        await stakingUser.stake(100, lockWeek);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 140;
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(expected);
        expect(totalDepositsWithBoost).to.equal(expected + expected2);

        // user 2 stakes again, 297. should get 415 shares due to rounding down
        await stakingUser2.stake(297, lockWeek);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 415; // 297 * 1.4 floored
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes3.amountWithBoost).to.equal(expected3);
        expect(totalDepositsWithBoost).to.equal(expected + expected2 + expected3);
      });

      it("should properly calculate a user's proportional share with two week boost", async () => {
        const { connectUser, signers, stakingUser } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user 2 stakes 88, should get 176 shares with a 100% boost
        await stakingUser2.stake(88, lockTwoWeeks);
        const stakes2 = await stakingUser2.stakes(user2.address, 0);

        const expected2 = 176;
        let totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes2.amountWithBoost).to.equal(expected2);
        expect(totalDepositsWithBoost).to.equal(expected2);

        // user 1 stakes 100, should get 482 shares
        await stakingUser.stake(241, lockTwoWeeks);
        const stakes = await stakingUser.stakes(signers[1].address, 0);

        const expected = 482;
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes.amountWithBoost).to.equal(expected);
        expect(totalDepositsWithBoost).to.equal(expected + expected2);

        // user 2 stakes again, 832. should get 1664 shares
        await stakingUser2.stake(832, lockTwoWeeks);
        const stakes3 = await stakingUser2.stakes(user2.address, 1);

        const expected3 = 1664;
        totalDepositsWithBoost = await stakingUser.totalDepositsWithBoost();
        expect(stakes3.amountWithBoost).to.equal(expected3);
        expect(totalDepositsWithBoost).to.equal(expected + expected2 + expected3);
      });
    });

    describe("unbond", () => {
      const rewardPerEpoch = ether(oneWeekSec.toString());
      const stakeAmount = ether("1000");

      beforeEach(async () => {
        await ctx.staking.setRewardsDuration(oneWeekSec);

        await ctx.staking.notifyRewardAmount(rewardPerEpoch);
        await ctx.stakingUser.stake(stakeAmount, lockDay);
      });

      it("should revert if passed an out of bounds deposit ID", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.unbond(2)).to.be.revertedWith("USR_NoDeposit");
      });

      it("should revert if the specified deposit is already unbonding", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.unbond(0)).to.not.be.reverted;

        await expect(stakingUser.unbond(0)).to.be.revertedWith("USR_AlreadyUnbonding");
      });

      it("should unbond a stake and remove any boosts", async () => {
        const { stakingUser, user } = ctx;

        const stake = await stakingUser.stakes(user.address, 0);
        const boostMultiplier = stakeAmount.mul(await stakingUser.ONE_DAY_BOOST()).div(ether("1"));
        const expectedAmountWithBoost = stakeAmount.add(boostMultiplier);
        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockDay);

        await expect(stakingUser.unbond(0))
          .to.emit(stakingUser, "Unbond")
          .withArgs(user.address, 0, stakeAmount);

        // Check updated stake
        const updatedStake = await stakingUser.stakes(user.address, 0);
        const latestBlock = await ethers.provider.getBlock("latest");

        expect(updatedStake.amount).to.equal(stakeAmount);
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount);
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneDaySec);
        expect(updatedStake.lock).to.equal(lockDay);
      });
    });

    describe("unbondAll", () => {
      const rewardPerEpoch = ether(oneWeekSec.toString());
      const stakeAmount = ether("1000");

      it("should unbond all stakes, skipping ones that have already been unbonded", async () => {
        const { staking, stakingUser, user } = ctx;

        await staking.setRewardsDuration(oneWeekSec);

        await staking.notifyRewardAmount(rewardPerEpoch);
        await stakingUser.stake(stakeAmount, lockDay);

        // Stake again
        await stakingUser.stake(stakeAmount.mul(2), lockWeek);
        await stakingUser.stake(stakeAmount.mul(3), lockTwoWeeks);

        // Unbond one stake
        await expect(stakingUser.unbond(1))
          .to.emit(stakingUser, "Unbond")
          .withArgs(user.address, 1, stakeAmount.mul(2));

        // Check updated stake
        let updatedStake = await stakingUser.stakes(user.address, 1);
        let latestBlock = await ethers.provider.getBlock("latest");

        expect(updatedStake.amount).to.equal(stakeAmount.mul(2));
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount.mul(2));
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneWeekSec);
        expect(updatedStake.lock).to.equal(lockWeek);

        const tx = await stakingUser.unbondAll();
        const receipt = await tx.wait();

        const unbondEvents = await receipt.events?.filter((e) => e.event === "Unbond");
        expect(unbondEvents?.length === 2);

        // Check other stakes updated
        updatedStake = await stakingUser.stakes(user.address, 0);
        latestBlock = await ethers.provider.getBlock("latest");

        expect(updatedStake.amount).to.equal(stakeAmount);
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount);
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneDaySec);
        expect(updatedStake.lock).to.equal(lockDay);

        updatedStake = await stakingUser.stakes(user.address, 2);

        expect(updatedStake.amount).to.equal(stakeAmount.mul(3));
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount.mul(3));
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneWeekSec * 2);
        expect(updatedStake.lock).to.equal(lockTwoWeeks);
      });
    });

    describe("cancelUnbonding", () => {
      const rewardPerEpoch = ether(oneWeekSec.toString());
      const stakeAmount = ether("1000");

      beforeEach(async () => {
        await ctx.staking.setRewardsDuration(oneWeekSec);

        await ctx.staking.notifyRewardAmount(rewardPerEpoch);
        await ctx.stakingUser.stake(stakeAmount, lockDay);
      });

      it("should revert if passed an out of bounds deposit ID", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.cancelUnbonding(2)).to.be.revertedWith("USR_NoDeposit");
      });

      it("should revert if the specified deposit is not unbonding", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.cancelUnbonding(0)).to.be.revertedWith("USR_NotUnbonding");
      });

      it("should cancel unbonding for a stake and reinstate any boosts", async () => {
        const { stakingUser, user } = ctx;

        const stake = await stakingUser.stakes(user.address, 0);
        const boostMultiplier = stakeAmount.mul(await stakingUser.ONE_DAY_BOOST()).div(ether("1"));
        const expectedAmountWithBoost = stakeAmount.add(boostMultiplier);
        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockDay);

        await expect(stakingUser.unbond(0)).to.not.be.reverted;

        // Check updated stake
        const updatedStake = await stakingUser.stakes(user.address, 0);
        const latestBlock = await ethers.provider.getBlock("latest");

        expect(updatedStake.amount).to.equal(stakeAmount);
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount);
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneDaySec);
        expect(updatedStake.lock).to.equal(lockDay);

        // Now cancel
        await expect(stakingUser.cancelUnbonding(0))
          .to.emit(stakingUser, "CancelUnbond")
          .withArgs(user.address, 0);

        const originalStake = await stakingUser.stakes(user.address, 0);

        expect(originalStake.amount).to.equal(stakeAmount);
        expect(originalStake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(originalStake.unbondTimestamp).to.equal(0);
        expect(originalStake.lock).to.equal(lockDay);
      });
    });

    describe("cancelUnbondingAll", () => {
      const rewardPerEpoch = ether(oneWeekSec.toString());
      const stakeAmount = ether("1000");

      it("should cancel unbonding all stakes, skipping ones that are not unbonding", async () => {
        const { staking, stakingUser, user } = ctx;

        await staking.setRewardsDuration(oneWeekSec);

        await staking.notifyRewardAmount(rewardPerEpoch);
        await stakingUser.stake(stakeAmount, lockDay);

        // Stake again
        await stakingUser.stake(stakeAmount, lockWeek);
        await stakingUser.stake(stakeAmount, lockTwoWeeks);

        // Unbond two stakes
        await expect(stakingUser.unbond(1)).to.not.be.reverted;
        await expect(stakingUser.unbond(2)).to.not.be.reverted;

        const tx = await stakingUser.cancelUnbondingAll();
        const receipt = await tx.wait();

        const cancelEvents = await receipt.events?.filter((e) => e.event === "CancelUnbond");
        expect(cancelEvents?.length === 2);

        // Check all stakes match original
        let stake = await stakingUser.stakes(user.address, 0);
        let boostMultiplier = stakeAmount.mul(await stakingUser.ONE_DAY_BOOST()).div(ether("1"));
        let expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockDay);

        stake = await stakingUser.stakes(user.address, 1);
        boostMultiplier = stakeAmount.mul(await stakingUser.ONE_WEEK_BOOST()).div(ether("1"));
        expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockWeek);

        stake = await stakingUser.stakes(user.address, 2);
        boostMultiplier = stakeAmount.mul(await stakingUser.TWO_WEEKS_BOOST()).div(ether("1"));
        expectedAmountWithBoost = stakeAmount.add(boostMultiplier);

        expect(stake.amount).to.equal(stakeAmount);
        expect(stake.amountWithBoost).to.equal(expectedAmountWithBoost);
        expect(stake.unbondTimestamp).to.equal(0);
        expect(stake.lock).to.equal(lockTwoWeeks);
      });
    });

    describe("unstake", () => {
      const rewardPerEpoch = ether(oneWeekSec.toString());
      const stakeAmount = ether("1000");

      beforeEach(async () => {
        await ctx.staking.setRewardsDuration(oneWeekSec);

        await ctx.staking.notifyRewardAmount(rewardPerEpoch);
        await ctx.stakingUser.stake(stakeAmount, lockDay);

      });

      it("should revert if passed an out of bounds deposit id", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.unstake(2)).to.be.revertedWith("USR_NoDeposit");
      });

      it("should not allow unstaking a stake that is still locked", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.unstake(0)).to.be.revertedWith("USR_StakeLocked");
      });

      it("should not allow unstaking if the unbonding period has not expired", async () => {
        const { stakingUser, user } = ctx;

        await increaseTime(oneWeekSec);

        // Unbond one stake
        await expect(stakingUser.unbond(0))
          .to.emit(stakingUser, "Unbond")
          .withArgs(user.address, 0, stakeAmount);

        // Check updated stake
        const updatedStake = await stakingUser.stakes(user.address, 0);
        const latestBlock = await ethers.provider.getBlock("latest");

        expect(updatedStake.amount).to.equal(stakeAmount);
        expect(updatedStake.amountWithBoost).to.equal(stakeAmount);
        expect(updatedStake.unbondTimestamp).to.equal(latestBlock.timestamp + oneDaySec);
        expect(updatedStake.lock).to.equal(lockDay);

        // try to very soon after unstake
        await increaseTime(1000);
        await expect(stakingUser.unstake(0)).to.be.revertedWith("USR_StakeLocked");
      });

      it("should require a non-zero amount to unstake", async () => {
        const { stakingUser, user, tokenDist } = ctx;

        await increaseTime(oneWeekSec);
        await stakingUser.unbond(0);

        const prevBal = await tokenDist.balanceOf(user.address);

        const stake = await stakingUser.stakes(user.address, 0);
        await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

        const tx = await stakingUser.unstake(0);
        const receipt = await tx.wait();

        const unstakeEvent = receipt.events?.find(e => e.event === "Unstake");

        expect(unstakeEvent).to.not.be.undefined;
        expect(unstakeEvent?.args?.[0]).to.equal(user.address);
        expect(unstakeEvent?.args?.[1]).to.equal(0);
        expect(unstakeEvent?.args?.[2]).to.equal(stakeAmount);
        expectRoundedEqual(unstakeEvent?.args?.[3], rewardPerEpoch);

        // single staker takes all rewards
        const bal = await tokenDist.balanceOf(user.address);
        expectRoundedEqual(bal.sub(prevBal), rewardPerEpoch);
      });

      it("should not unstake more than the deposited amount", async () => {
        const { stakingUser, user, tokenStake } = ctx;

        await increaseTime(oneWeekSec);
        await stakingUser.unbond(0);

        const prevBal = await tokenStake.balanceOf(user.address);

        const stake = await stakingUser.stakes(user.address, 0);
        await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

        await stakingUser.unstake(0);

        // previous bal + staked amount should equal current balance
        const bal = await tokenStake.balanceOf(user.address);
        expect(prevBal.add(stakeAmount)).to.equal(bal);
      });

      it("should unstake, distributing both the specified deposit amount and any accumulated rewards", async () => {
        const { stakingUser, user, tokenStake, tokenDist } = ctx;

        await increaseTime(oneWeekSec);
        await stakingUser.unbond(0);

        const prevBal = await tokenStake.balanceOf(user.address);

        const stake = await stakingUser.stakes(user.address, 0);
        await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

        await stakingUser.unstake(0);

        // previous bal + staked amount should equal current balance
        const bal = await tokenStake.balanceOf(user.address);
        expect(prevBal.add(stakeAmount)).to.equal(bal);

        const rewardsBal = await tokenDist.balanceOf(user.address);
        expectRoundedEqual(rewardsBal, rewardPerEpoch);
      });
    });

    describe("unstakeAll", () => {
      const rewardPerEpoch = ether(String(2_000_000)); // 2M
      const stakeAmount = ether("50000");

      beforeEach(async () => {
        await ctx.staking.setRewardsDuration(oneWeekSec * 3);
        await ctx.staking.notifyRewardAmount(rewardPerEpoch.mul(3));
        await ctx.stakingUser.stake(stakeAmount, lockDay);
      });

      it("should unstake all amounts for all deposits, and distribute all available rewards", async () => {
        const { connectUser, signers, stakingUser, user, tokenDist, tokenStake } = ctx;
        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);

        // user1 should collect all of first week reward
        await increaseTime(oneWeekSec);

        // week 2 and 3 reward should be split 2/3 to 1/3
        await stakingUser2.stake(stakeAmount, lockDay);
        await stakingUser.stake(stakeAmount, lockDay);

        // End rewards
        await increaseTime(oneWeekSec * 3);

        await stakingUser.unbondAll();
        await stakingUser2.unbondAll();

        const prevStakeBal = await tokenStake.balanceOf(user.address);
        const prevDistBal = await tokenDist.balanceOf(user.address);

        const stake = await stakingUser.stakes(user.address, 0);
        await setNextBlockTimestamp(stake.unbondTimestamp.toNumber() + 1);

        await stakingUser.unstakeAll();
        await stakingUser2.unstakeAll();

        // expect to recover balance that was initially staked
        const totalStaked = stakeAmount.mul(2);
        const stakeBal = await tokenStake.balanceOf(user.address);

        expect(prevStakeBal.add(BigNumber.from(totalStaked))).to.equal(stakeBal);

        // expect to collect all rewards of first week, and 2/3 rewards of weeks 2 and 3
        // for 7/9 total
        const expectedRewardsUser1 = rewardPerEpoch.div(3).mul(7);
        const distBalUser1 = await tokenDist.balanceOf(user.address);
        expectRoundedEqual(distBalUser1.sub(prevDistBal), expectedRewardsUser1);

        const expectedRewardsUser2 = rewardPerEpoch.div(3).mul(2);
        const distBalUser2 = await tokenDist.balanceOf(user2.address);
        expectRoundedEqual(distBalUser2.sub(prevDistBal), expectedRewardsUser2);
      });
    });

    describe("claim", () => {
      describe("uninitialized", () => {
        it("should not allow claiming if the rewards are not initialized");
      });

      describe("initialized", () => {
        const rewardPerEpoch = oneWeekSec;
        const stakeAmount = ether("1000");

        beforeEach(async () => {
          await ctx.staking.setRewardsDuration(oneWeekSec);
          await ctx.staking.notifyRewardAmount(rewardPerEpoch);
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
    });

    // describe("emergencyUnstake", () => {
    //   beforeEach(async () => {
    //     await ctx.staking.initializePool(1, oneWeekSec);
    //   });

    //   it("should revert if the staking program has not been ended", async () => {
    //     const { stakingUser } = ctx;

    //     await expect(stakingUser.emergencyUnstake()).to.be.revertedWith("STATE_NoEmergencyUnstake");
    //   });

    //   it("should return all staked tokens, across multiple stakes, regardless of lock status", async () => {
    //     const { connectUser, signers, staking, stakingUser, tokenStake, user } = ctx;
    //     await stakingUser.stake(initialTokenAmount, lockDay);
    //     expect(await tokenStake.balanceOf(user.address)).to.equal(0);

    //     const user2 = signers[2];
    //     const stakingUser2 = await connectUser(user2);
    //     await stakingUser2.stake(initialTokenAmount, lockWeek);
    //     expect(await tokenStake.balanceOf(user2.address)).to.equal(0);

    //     const user3 = signers[3];
    //     const stakingUser3 = await connectUser(user3);
    //     await stakingUser3.stake(initialTokenAmount, lockTwoWeeks);
    //     expect(await tokenStake.balanceOf(user3.address)).to.equal(0);

    //     await staking.emergencyStop(false);
    //     await stakingUser.emergencyUnstake();
    //     expect(await tokenStake.balanceOf(user.address)).to.equal(initialTokenAmount);

    //     await stakingUser2.emergencyUnstake();
    //     expect(await tokenStake.balanceOf(user2.address)).to.equal(initialTokenAmount);

    //     await stakingUser3.emergencyUnstake();
    //     expect(await tokenStake.balanceOf(user3.address)).to.equal(initialTokenAmount);
    //   });

    //   it("should allow rewards to be claimable");
    // });

    // describe("emergencyClaim", () => {
    //   it("should revert if the staking program has not been ended", async () => {
    //     const { stakingUser } = ctx;

    //     await expect(stakingUser.emergencyClaim()).to.be.revertedWith("STATE_NoEmergencyUnstake");
    //   });

    //   it("should revert if the contract stopped with claim disabled", async () => {
    //     const { staking, stakingUser } = ctx;

    //     await staking.emergencyStop(false);
    //     await expect(stakingUser.emergencyClaim()).to.be.revertedWith("STATE_NoEmergencyClaim");
    //   });

    //   it("should return all staked tokens and distribute all unclaimed rewards");
    // });
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
