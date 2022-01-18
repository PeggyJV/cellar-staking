import hre from "hardhat";
import { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { Contract, Signer } from "ethers";

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

export async function increaseTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
}

export async function setNextBlockTimestamp(epoch: number): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [epoch]);
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
