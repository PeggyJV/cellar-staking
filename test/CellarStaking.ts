import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import type { Greeter } from "../src/types/Greeter";
import { deploy } from "./utils";

interface TestContext {
  // signers: SignerWithAddress[];
  // admin: SignerWithAddress;
  // greeter: Greeter;
}

describe("CellarStaking", () => {
  let ctx: TestContext;

  const fixture = async (): Promise<TestContext> => {
    // const signers: SignerWithAddress[] = await ethers.getSigners();
    // const greeter = <Greeter>await deploy("Greeter", signers[0], ["Hello, world!"]);

    // return {
    //   signers,
    //   admin: signers[0],
    //   greeter,
    // };
    return {};
  };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
  });

  describe("User Operations", () => {
    describe("stake", () => {
      it("should not allow staking if the rewards are not initialized");
      it("should not allow a user to stake if the stake in under the minimum");
      it("should not allow a user to stake if there are no rewards left");
      it("should not allow a user to stake if their stake is too small to receive a share");
      it("should revert for an invalid lock value");
      it("should allow a user to stake and calculate correct proportional share");
      it("should properly calculate a user's proportional share after locking boosts");
      it("should allocate correct proportional shares for multiple depositors");
    });

    describe("unstake", () => {
      it("should not allow unstaking if the rewards are not initialized");
      it("should require a non-zero amount to unstake");
      it("should revert if the depositId is invalid");
      it("should not allow unstaking a stake that is still locked");
      it("should not unstake more than the deposited amount");
      it("should not allow a user to unstake an amount smaller than the unit share size");
      it("should unstake, distributing both the specified deposit amount and any accumulated rewards");
    });

    describe("unstakeAll", () => {
      it("should unstake all amounts for all deposits, and distribute all available rewards");
    });

    describe("claim", () => {
      it("should not allow claiming if the rewards are not initialized");
      it("claim available rewards for a given deposit");
      it("should correctly calculate rewards for two claims within the same epoch");
      it("should correctly calculate rewards across multiple epochs");
      it("should corretctly calculate proportional rewards across different user's stakes, in the same epoch");
      it(
        "should correctly calculate proportional rewards for different user stakes, deposited during different epochs",
      );
      it("should not redistribute rewards tha have already been claimed");
    });

    describe("claimAll", () => {
      it("should claim all available rewards for all deposits, within the same epoch");
      it("should claim all available rewards for all deposits, across multiple epochs");
    });

    describe("emergencyUnstake", () => {
      it("should revert if the staking program has not been ended");
      it("should return all staked tokens, across multiple stakes, regardless of lock status");
    });

    describe("emergencyClaim", () => {
      it("should revert if the staking program has not been ended");
      it("should return all staked tokens and distribute all unclaimed rewards");
    });
  });

  describe("Admin Operations", () => {
    describe("initializePool", () => {
      it("should revert if caller is not the owner");
      it("should revert if the contract is paused");
      it("should revert if the staking pool has previously been initialized");
      it("should revert if the number of epochs is 0");
      it("should revert if the number of epochs is more than the maximum");
      it("should revert if the epoch length is 0");
      it("should revert if the rewards per epoch is 0");
      it("should revert if the owner cannot fund the reward epochs");
      it("should create new reward epochs and store them in contract state");
    });

    describe("replenishPool", () => {
      it("should revert if caller is not the owner");
      it("should revert if the contract is paused");
      it("should revert if the staking pool has not previously been initialized");
      it("should revert if the number of new epochs is 0");
      it("should revert if the number of new epochs plus previous epochs is more than the maximum");
      it("should revert if the epoch length is 0");
      it("should revert if the rewards per epoch is 0");
      it("should revert if the owner cannot fund the new reward epochs");
      it("should create new reward epochs and store them in contract state, appending to existing state");
    });

    describe("updateMinimumDeposit", () => {
      it("should revert if caller is not the owner");
      it("should set a new minimum staking deposit and immediately enforce it");
    });

    describe("setPaused", () => {
      it("should revert if caller is not the owner");
      it("should pause the contract");
      it("should unpause the contract");
    });

    describe("emergencyStop", () => {
      it("should revert if caller is not the owner");
      it("should end the contract while making rewards claimable");
      it("should end the contract and return distribution tokens if rewards are not claimable");
      it("should revert if called more than once");
    });
  });

  describe("State Information", () => {
    describe("currentEpoch", () => {
      it("should report the correct epoch for the current time");
      it("should revert if there is no active epoch");
    });

    describe("epochAtTime", () => {
      it("should report the correct epoch for the specified time");
      it("should revert if there is no active epoch at the time specified");
    });

    describe("totalRewards", () => {
      it("should report the total rewards scheduled across all epochs");
    });
  });
});
