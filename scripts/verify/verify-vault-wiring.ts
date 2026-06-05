import { network } from "hardhat";

const EXPECTED_VAULT = "0x2D598EEe72cBEAf2Fa020D1c068051D4801Ba3D4";
const EXPECTED_SETHX = "0xd603b12f7458d44ddf30e48e72c640c9b6f9d61f";
const EXPECTED_REGISTRY = "0x38D4F2F307657Cc6972711fb1cA52071E9805e12";

async function readMaybeFunction(contract: any, name: string) {
  const value = contract[name];

  if (typeof value === "function") {
    return await value();
  }

  return value;
}

async function main() {
  const { ethers } = await network.connect("mainnet");

  const vault = await ethers.getContractAt("SethxVault", EXPECTED_VAULT);

  const actualSethx = await readMaybeFunction(vault, "sethxToken");
  const actualRegistry = await readMaybeFunction(vault, "accountRegistry");

  console.log("Vault:", EXPECTED_VAULT);
  console.log("SETHX token:", actualSethx);
  console.log("Account registry:", actualRegistry);

  if (actualSethx.toLowerCase() !== EXPECTED_SETHX.toLowerCase()) {
    throw new Error(
      `Wrong SETHX token. Expected ${EXPECTED_SETHX}, got ${actualSethx}`,
    );
  }

  if (actualRegistry.toLowerCase() !== EXPECTED_REGISTRY.toLowerCase()) {
    throw new Error(
      `Wrong registry. Expected ${EXPECTED_REGISTRY}, got ${actualRegistry}`,
    );
  }

  console.log("Vault wiring verified successfully");
}

await main();
