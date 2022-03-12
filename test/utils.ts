import hre from "hardhat";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { Contract, Signer, BigNumberish } from "ethers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { CellarStaking } from "../src/types/CellarStaking";

const { deployContract } = hre.waffle;

export const ether = ethers.utils.parseEther;

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

// export async function rollNextEpoch(staking: CellarStaking): Promise<number> {

//   const currentEpoch = (await staking.currentEpoch()).toNumber();
//   const nextEpochIdx = currentEpoch + 1;

//   const nextEpoch = await staking.rewardEpochs(nextEpochIdx);
//   const timestamp = nextEpoch.startTimestamp.toNumber();
//   await setNextBlockTimestamp(timestamp);

//   return timestamp;
// }

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