import { network } from "hardhat";

export async function createTestNetwork() {
  return await network.create();
}
