import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

import { CellarStaking } from "../../src/types/CellarStaking";
import { CellarStaking__factory } from "../../src/types/factories/CellarStaking__Factory";

const oneDaySec = 60 * 60 * 24;
const oneWeekSec = oneDaySec * 7;

task("deploy:CellarStaking")
  .setAction(async function (args: TaskArguments, { ethers }) {
    const signers = await ethers.getSigners();
    const [deployer] = signers;

    console.log("Deployer address: ", deployer.address);
    console.log("Deployer balance: ", (await deployer.getBalance()).toString());

    const OPERATOR = deployer.address;
    const LP_SHARE = "0x067047DA291671fA4F69884414454CA496101d8F";    // AAVE Cellar
    const SOMM_TOKEN = "0xa670d7237398238DE01267472C6f13e5B8010FD1";

    const factory = <CellarStaking__factory>await ethers.getContractFactory("CellarStaking");

    const staking = <CellarStaking>await factory.deploy(
      OPERATOR,                         // gravity (deployer for now)
      OPERATOR,                         // gravity (reward distributor)
      LP_SHARE,                         // cellar lp token
      SOMM_TOKEN,                       // SOMM ERC20 token
      60 * 60 * 24 * 30,                // 30 days,
      ethers.utils.parseUnits("0.1"),   // 10% short boost
      ethers.utils.parseUnits("0.3"),   // 30% medium boost
      ethers.utils.parseUnits("0.5"),   // 50% long boost
      oneWeekSec,                       // 1-week short locktime
      oneWeekSec * 2,                   // 2-week medium locktime
      oneWeekSec * 3,                   // 3-week long locktime
    );

    await staking.deployed();

    console.log("CellarStaking deployed to: ", staking.address);

    // Gravity needs to call notifyRewardAmount to start staking program
  });
