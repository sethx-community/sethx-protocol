import { network } from "hardhat";

function normalizePrivateKey(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error("DEPLOYER_PRIVATE_KEY is missing");
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  const { ethers } = await network.connect("mainnet");

  const privateKey = normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
  const wallet = new ethers.Wallet(privateKey);
  const deployer = await wallet.getAddress();

  const hash =
    "0x03393d7c74dad657eef2cfa113519d6cba15dc39d15b411c6e14047b2ea91041";

  const predictedAddress = "0x9648BEb66cA9f1c1Dfdc432B68730d11f1313A36";

  console.log("deployer", deployer);
  console.log("network", await ethers.provider.getNetwork());

  const latest = await ethers.provider.getTransactionCount(deployer, "latest");
  const pending = await ethers.provider.getTransactionCount(
    deployer,
    "pending",
  );

  console.log("latest nonce", latest);
  console.log("pending nonce", pending);

  console.log("tx", await ethers.provider.getTransaction(hash));
  console.log("receipt", await ethers.provider.getTransactionReceipt(hash));

  console.log(
    "raw tx",
    await ethers.provider.send("eth_getTransactionByHash", [hash]),
  );

  console.log(
    "raw receipt",
    await ethers.provider.send("eth_getTransactionReceipt", [hash]),
  );

  console.log(
    "predicted code",
    await ethers.provider.getCode(predictedAddress),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
