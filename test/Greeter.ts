import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import type { Greeter } from "../src/types/Greeter";
import { deploy } from "./utils";

interface TestContext {
  signers: SignerWithAddress[];
  admin: SignerWithAddress;
  greeter: Greeter;
}

describe("Unit tests", () => {
  let ctx: TestContext;

  const fixture = async (): Promise<TestContext> => {
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const greeter = <Greeter>await deploy("Greeter", signers[0], ["Hello, world!"]);

    return {
      signers,
      admin: signers[0],
      greeter,
    };
  };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
  });

  describe("Greeter", () => {
    it("should behave like greeter", async () => {
      const { greeter, admin } = ctx;

      expect(await greeter.connect(admin).greet()).to.equal("Hello, world!");

      await greeter.setGreeting("Bonjour, le monde!");
      expect(await greeter.connect(admin).greet()).to.equal("Bonjour, le monde!");
    });
  });
});
