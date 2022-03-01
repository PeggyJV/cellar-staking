import hre from "hardhat";
import { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { Contract, Signer } from "ethers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { CellarStaking } from "../src/types/CellarStaking";

const { deployContract } = hre.waffle;

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
}

export async function setNextBlockTimestamp(epoch: number): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [epoch]);
}

export async function rollNextEpoch(staking: CellarStaking): Promise<number> {
  const currentEpoch = (await staking.currentEpoch()).toNumber();
  const nextEpochIdx = currentEpoch + 1;

  const nextEpoch = await staking.rewardEpochs(nextEpochIdx);
  const timestamp = nextEpoch.startTimestamp.toNumber();
  await setNextBlockTimestamp(timestamp);

  return timestamp;
}

export async function unbondUnstake(staking: CellarStaking, user: SignerWithAddress, depositId: number): Promise<void> {
  await staking.unbond(depositId);
  const stake = await staking.stakes(user.address, depositId);
  const unbondTimestamp = stake.unbondTimestamp.toNumber();

  await setNextBlockTimestamp(unbondTimestamp + 1);
  await staking.unstake(depositId);
}
