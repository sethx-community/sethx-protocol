import { expect } from "chai";
import { network } from "hardhat";

import { readLocalDeployment, requireLocalAddress } from "../helpers/deployment-reader.js";

const { ethers } = await network.create();

async function expectRole(contract: any, role: string, account: string, label: string) {
  expect(await contract.hasRole(role, account), label).to.equal(true);
}

describe("Futures deployment", function () {
  it("wires futures contracts without SettlementManager and grants required vault/orderbook roles", async function () {
    const deployment = readLocalDeployment();
    const futuresContractAddress = requireLocalAddress(deployment, "futuresContract");
    const futuresOrderBookAddress = requireLocalAddress(deployment, "futuresOrderBook");
    const vaultAddress = requireLocalAddress(deployment, "sethxVault");
    const priceManagerAddress = requireLocalAddress(deployment, "priceManager");

    expect((deployment.addresses as any).settlementManager, "SettlementManager should not be required after futures redesign").to.equal(undefined);

    const futuresContract = await ethers.getContractAt("FuturesContract", futuresContractAddress);
    const futuresOrderBook = await ethers.getContractAt("FuturesOrderBook", futuresOrderBookAddress);
    const vault = await ethers.getContractAt("SethxVault", vaultAddress);

    expect(await futuresContract.priceManager()).to.equal(priceManagerAddress);
    expect(await futuresOrderBook.futures()).to.equal(futuresContractAddress);
    expect(await futuresOrderBook.vault()).to.equal(vaultAddress);

    await expectRole(
      futuresContract,
      await futuresContract.ORDERBOOK_ROLE(),
      futuresOrderBookAddress,
      "FuturesOrderBook must mutate FuturesContract positions",
    );

    await expectRole(
      vault,
      await vault.ORDERBOOK_ROLE(),
      futuresOrderBookAddress,
      "FuturesOrderBook must lock/transfer order collateral and fees",
    );

    await expectRole(
      vault,
      await vault.SETTLEMENT_ROLE(),
      futuresContractAddress,
      "FuturesContract must collect/pay futures settlement pool balances",
    );

    await expectRole(
      vault,
      await vault.ORDERBOOK_ROLE(),
      futuresContractAddress,
      "FuturesContract must lock/unlock margin for direct account actions",
    );
  });
});
