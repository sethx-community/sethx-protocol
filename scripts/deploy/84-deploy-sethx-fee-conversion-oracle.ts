import { safeDeployContract } from "./safe-deploy-contract.js";

const DEFAULT_LOCAL_SETHX_PER_ETH = 20_000n * 10n ** 18n;

export async function deploySethxFeeConversionOracle(ethers: any) {
  const [deployer] = await ethers.getSigners();

  const oracle = await safeDeployContract(ethers, "SethxFeeConversionOracle", [
    await deployer.getAddress(),
    DEFAULT_LOCAL_SETHX_PER_ETH,
  ]);

  return {
    addresses: {
      sethxFeeConversionOracle: await oracle.getAddress(),
    },
    oracle: {
      sethxFeeConversionOracle: {
        sethxPerEth: DEFAULT_LOCAL_SETHX_PER_ETH.toString(),
        decimals: 18,
      },
    },
  };
}
