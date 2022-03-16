import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

import { CellarStaking } from "../../src/types/CellarStaking";
import { CellarStaking__factory } from "../../src/types/factories/CellarStaking__Factory";

task("deploy:CellarStaking")
  .addParam("operator", "The contract owner and default reward distributor")
  .addParam("lpshare", "The LP token used for staking")
  .addParam("somm", "The SOMM ERC20 token")
  .setAction(async function (args: TaskArguments, { ethers }) {
    const factory = <CellarStaking__factory>await ethers.getContractFactory("CellarStaking");

    const staking = <CellarStaking>await factory.deploy(
      args.operator,          // gravity
      args.operator,          // gravity (reward distributor)
      args.lpshare,           // cellar lp token
      args.somm,              // SOMM ERC20 token
      60 * 60 * 24 * 30       // 30 days
    );

    await staking.deployed();

    console.log("CellarStaking deployed to: ", staking.address);

    // Gravity needs to call notifyRewardAmount to start staking program
  });
