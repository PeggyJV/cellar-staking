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

    const OPERATOR = "0x7340D1FeCD4B64A4ac34f826B21c945d44d7407F"; // multisig
    const SOMM_TOKEN = "0xa670d7237398238DE01267472C6f13e5B8010FD1";

    const factory = <CellarStaking__factory>await ethers.getContractFactory("CellarStaking");

    const tokens = [
      // { name: "ETHBTCMOM", address: "0x6E2dAc3b9E9ADc0CbbaE2D0B9Fd81952a8D33872" }, // ETHBTCMOM
      // { name: "ETHBTCTREND", address: "0x6b7f87279982d919Bbf85182DDeAB179B366D8f2" }, // ETHBTCTREND
      // { name: "AAVE", address: "0x7bAD5DF5E11151Dc5Ee1a648800057C5c934c0d5" },
      // { name: "AAVE", address: "0x7bAD5DF5E11151Dc5Ee1a648800057C5c934c0d5" },
      { name: "STEADYETH", address: "0x3F07A84eCdf494310D397d24c1C78B041D2fa622" },
      { name: "STEADYBTC", address: "0x4986fD36b6b16f49b43282Ee2e24C5cF90ed166d" },
    ];

    for (const token of tokens) {
      const staking = <CellarStaking>await factory.deploy(
        OPERATOR,                         // gravity (deployer for now)
        token.address,                    // cellar lp token
        SOMM_TOKEN,                       // SOMM ERC20 token
        60 * 60 * 24 * 14,                // 14 days,
        ethers.utils.parseUnits("0.1"),   // 10% short boost
        ethers.utils.parseUnits("0.2"),   // 20%% medium boost
        ethers.utils.parseUnits("0.25"),  // 25% long boost
        oneDaySec * 10,                   // 10-day short locktime
        oneDaySec * 14,                   // 14-day medium locktime
        oneDaySec * 20,                   // 20-day long locktime
      );

      await staking.deployed();

      console.log(`CellarStaking ${token.name} deployed to: `, staking.address);
    }

    // Gravity needs to call:
    // - notifyRewardAmount to start staking program
  });
