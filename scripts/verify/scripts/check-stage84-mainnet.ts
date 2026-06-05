import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect("mainnet");

  const priceManagerAddress = "0xA712C58cF895E7e61b58cfdFE0d8114e89348466";
  const sethxFeeConversionOracleAddress =
    "0xF6CC59b7086C7AD12b1989EbeCF313222567181C";
  const usdcEthOracleAddress = "0x6786d468d6d1eb1461ac80d61058270cca67d9e2";

  const priceManager = await ethers.getContractAt(
    "PriceManager",
    priceManagerAddress,
  );

  const sethxFeeConversionOracle = await ethers.getContractAt(
    "SethxFeeConversionOracle",
    sethxFeeConversionOracleAddress,
  );

  const usdcEthOracle = await ethers.getContractAt(
    "ChainlinkUsdcEthOracle",
    usdcEthOracleAddress,
  );

  console.log("PriceManager:", priceManagerAddress);
  console.log("SethxFeeConversionOracle:", sethxFeeConversionOracleAddress);
  console.log("ChainlinkUsdcEthOracle:", usdcEthOracleAddress);

  console.log(
    "Sethx oracle approved:",
    await priceManager.isApprovedOracle(sethxFeeConversionOracleAddress),
  );

  console.log(
    "USDC/ETH oracle approved:",
    await priceManager.isApprovedOracle(usdcEthOracleAddress),
  );

  console.log(
    "Sethx oracle metadata:",
    await sethxFeeConversionOracle.metadata(),
  );
  console.log("USDC/ETH oracle metadata:", await usdcEthOracle.metadata());

  console.log(
    "Sethx oracle last price:",
    await sethxFeeConversionOracle.getLastPrice(),
  );
  console.log(
    "USDC/ETH oracle last price:",
    await usdcEthOracle.getLastPrice(),
  );

  console.log("USDC/ETH oracle decimals:", await usdcEthOracle.decimals());
  console.log("USDC/ETH feed decimals:", await usdcEthOracle.feedDecimals());
  console.log("USDC/ETH formula:", await usdcEthOracle.fetchFormula());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
