import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

export async function main(): Promise<void> {
  console.log(SECTION_SEPARATOR);
  const signers = await ethers.getSigners();
  console.log("Deployer address: ", signers[0].address);
  console.log("Deployer balance: ", (await signers[0].getBalance()).toString());
  console.log(SECTION_SEPARATOR);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: Error) => {
      console.error(error);
      process.exit(1);
    });
}
