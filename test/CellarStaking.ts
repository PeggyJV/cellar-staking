import { BigNumber } from "ethers";
import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import type { CellarStaking } from "../src/types/CellarStaking";
import type { MockERC20 } from "../src/types/MockERC20";
import { deploy, increaseTime, rand, setNextBlockTimestamp } from "./utils";

interface TestContext {
  signers: SignerWithAddress[];
  admin: SignerWithAddress;
  user: SignerWithAddress;
  tokenStake: MockERC20;
  tokenDist: MockERC20;
  maxEpochs: number;
  staking: CellarStaking;
  stakingUser: CellarStaking;
}

const oneDaySec = 60 * 60 * 24;
const hundred = BigNumber.from(100);

describe("CellarStaking", () => {
  let ctx: TestContext;
  let connectUser: (signer: SignerWithAddress) => Promise<CellarStaking>;
  const initialTokenAmount = 1000000; // 1,000,000
  const initialBN = BigNumber.from(initialTokenAmount);

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

    // test chain starts at block.timestamp 0, must increase it to pass startTimestamp checks
    await setNextBlockTimestamp(Date.now());

    connectUser = async (signer: SignerWithAddress): Promise<CellarStaking> => {
      const stake = await tokenStake.connect(signer);
      await stake.mint(signer.address, initialTokenAmount);
      await stake.increaseAllowance(staking.address, initialTokenAmount);

      return staking.connect(signer);
    };

    return {
      signers,
      admin,
      user,
      tokenStake,
      tokenDist,
      maxEpochs,
      staking,
      stakingUser,
    };
  };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
  });

  describe("User Operations", () => {
    describe("stake, uninitialized", () => {
      it("should not allow staking if the rewards are not initialized", async () => {
        const { stakingUser } = ctx;

        await expect(stakingUser.stake(1000, 0)).to.be.revertedWith("STATE_ContractPaused");
      });
    });

    describe("stake, initialized to one wei per epoch sec", () => {
      beforeEach(async () => {
        await ctx.staking.initializePool(oneDaySec, oneDaySec, 1);
      });

      it("should not allow a user to stake if the stake is under the minimum", async () => {
        const { staking, stakingUser } = ctx;
        const min = 100;
        await staking.updateMinimumDeposit(min);

        await expect(stakingUser.stake(min - 1, 0)).to.be.revertedWith("USR_MinimumDeposit");
      });

      it("should not allow a user to stake if there are no rewards left", async () => {
        const { stakingUser } = ctx;
        await increaseTime(oneDaySec + 15); // epoch has not completed

        await expect(stakingUser.stake(1, 0)).to.be.revertedWith("STATE_NoRewardsLeft");
      });

      it("should not allow a user to stake if their stake is too small to receive a share");

      it("should revert for an invalid lock value", async () => {
        const { stakingUser } = ctx;
        await expect(stakingUser.stake(1, 99)).to.be.revertedWith("function was called with incorrect parameter");
      });

      it("should allow one user to stake with 100% proportional share", async () => {
        const { stakingUser, user } = ctx;
        await stakingUser.stake(100000, 0);

        const stakes = await stakingUser.stakes(user.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber());
      });

      it("should allow two users to stake with an even proportional share", async () => {
        const { signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount, 0);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount, 0);

        const stakes = await stakingUser.stakes(user.address, 0);
        const stakes2 = await stakingUser.stakes(user2.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber() / 2);
        expect(stakes.shares.toNumber()).to.equal(stakes2.shares.toNumber());
      });

      it("should allow three users to stake with an even proportional share", async () => {
        const { signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount, 0);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount, 0);

        const user3 = signers[3];
        const stakingUser3 = await connectUser(user3);
        await stakingUser3.stake(amount, 0);

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
        const { signers, stakingUser, user } = ctx;
        const amount = 100000;
        await stakingUser.stake(amount * x, 0);

        const user2 = signers[2];
        const stakingUser2 = await connectUser(user2);
        await stakingUser2.stake(amount * y, 0);

        const stakes = await stakingUser.stakes(user.address, 0);
        const stakes2 = await stakingUser.stakes(user2.address, 0);
        const totalShares = await stakingUser.totalShares();
        expect(stakes.shares.toNumber()).to.equal(totalShares.toNumber() * x);
        expect(stakes2.shares.toNumber()).to.equal(totalShares.toNumber() * y);
      });

      it("should correctly calculate stake shares for two users", async () => {
        // number of runs
        const times = 10;

        for (let i = 0; i < times; i++) {
          ctx = await loadFixture(fixture);
          await ctx.staking.initializePool(oneDaySec, oneDaySec, 1);
          const { signers, stakingUser, user } = ctx;

          // javascript floating point arithmetic is imprecise
          // user1 stakes x (x is a range 50-100 inclusive)
          // user2 stakes 100 - x
          const x = BigNumber.from(rand(50, 100));
          const amount1 = initialBN.mul(x).div(hundred).toNumber();
          const amount2 = initialTokenAmount - amount1;
          console.log(`staking (${x.toNumber()} / ${100 - x.toNumber()}): ${amount1} : ${amount2}`);

          await stakingUser.stake(amount1, 0);

          const user2 = signers[2];
          const stakingUser2 = await connectUser(user2);
          await stakingUser2.stake(amount2, 0);

          const shares1 = (await stakingUser.stakes(user.address, 0)).shares;
          const shares2 = (await stakingUser.stakes(user2.address, 0)).shares;
          const totalShares = await stakingUser.totalShares();

          const expected1 = shares1.mul(initialBN).div(totalShares).toNumber();
          const expected2 = shares2.mul(initialBN).div(totalShares).toNumber();
          expect(expected1).to.equal(amount1);
          expect(expected2).to.equal(amount2);
        }
      });

      it.only("fuzzing with random number of users and staked amounts", async () => {
        // global fuzzing parameters
        const times = 1;
        const minStake = 100; //100000
        const maxStake = 10000; //initialTokenAmount

        for (let i = 0; i < times; i++) {
          // reset fixture
          ctx = await loadFixture(fixture);
          await ctx.staking.initializePool(oneDaySec, oneDaySec, 1);

          // setup fuzzing scenario
          const numUsers = rand(2, 19); // Max signers = 10 because 0 is admin
          const signers = <SignerWithAddress[]>[...Array(numUsers).keys()].map(i => ctx.signers[i + 1]);
          const amounts = new Map<SignerWithAddress, number>();
          let totalStaked = BigNumber.from(0);

          // stake a random amount for each signer
          for (const signer of signers) {
            const staking = await connectUser(signer);
            const amount = rand(minStake, maxStake); // inclusive
            await staking.stake(amount, 0);

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

      it("should properly calculate a user's proportional share after locking boosts");
      it("should allocate correct proportional shares for multiple depositors");
    });
    //
    //   describe("unstake", () => {
    //     it("should not allow unstaking if the rewards are not initialized");
    //     it("should require a non-zero amount to unstake");
    //     it("should revert if the depositId is invalid");
    //     it("should not allow unstaking a stake that is still locked");
    //     it("should not unstake more than the deposited amount");
    //     it("should not allow a user to unstake an amount smaller than the unit share size");
    //     it("should unstake, distributing both the specified deposit amount and any accumulated rewards");
    //   });
    //
    //   describe("unstakeAll", () => {
    //     it("should unstake all amounts for all deposits, and distribute all available rewards");
    //   });
    //
    //   describe("claim", () => {
    //     it("should not allow claiming if the rewards are not initialized");
    //     it("claim available rewards for a given deposit");
    //     it("should correctly calculate rewards for two claims within the same epoch");
    //     it("should correctly calculate rewards across multiple epochs");
    //     it("should corretctly calculate proportional rewards across different user's stakes, in the same epoch");
    //     it(
    //       "should correctly calculate proportional rewards for different user stakes, deposited during different epochs",
    //     );
    //     it("should not redistribute rewards tha have already been claimed");
    //   });
    //
    //   describe("claimAll", () => {
    //     it("should claim all available rewards for all deposits, within the same epoch");
    //     it("should claim all available rewards for all deposits, across multiple epochs");
    //   });
    //
    //   describe("emergencyUnstake", () => {
    //     it("should revert if the staking program has not been ended");
    //     it("should return all staked tokens, across multiple stakes, regardless of lock status");
    //   });
    //
    //   describe("emergencyClaim", () => {
    //     it("should revert if the staking program has not been ended");
    //     it("should return all staked tokens and distribute all unclaimed rewards");
    //   });
    // });
    //
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
  });
});
