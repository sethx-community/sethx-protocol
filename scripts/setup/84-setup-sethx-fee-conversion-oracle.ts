import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

const FEE_CONVERSION_CONTEXT = 5;
const SETHX_FEE_CONVERSION_LABEL = "SETHX fee conversion";
const SETHX_FEE_CONVERSION_DESCRIPTION =
  "Governor-managed SETHX per ETH oracle used only for fee conversion.";

function sameAddress(ethers: any, left: string, right: string) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function includesAddress(ethers: any, addresses: string[], target: string) {
  return addresses.some((address) => sameAddress(ethers, address, target));
}

export async function setupSethxFeeConversionOracle(
  ethers: any,
  deployment: {
    addresses: {
      priceManager: string;
      sethxToken: string;
      sethxFeeConversionOracle: string;
    };
  },
) {
  const priceManager = await ethers.getContractAt(
    "PriceManager",
    deployment.addresses.priceManager,
  );
  const sethxFeeConversionOracle = await ethers.getContractAt(
    "SethxFeeConversionOracle",
    deployment.addresses.sethxFeeConversionOracle,
  );

  const actions: string[] = [];
  const oracleAddress = deployment.addresses.sethxFeeConversionOracle;
  const sethxToken = deployment.addresses.sethxToken;

  if (!(await priceManager.isApprovedOracle(oracleAddress))) {
    const tx = await priceManager.approveOracle(oracleAddress);
    await tx.wait();
    actions.push("approveOracle");
  }

  const metadata = await priceManager.getOracleMetadata(oracleAddress);
  if (
    !sameAddress(ethers, metadata.token, sethxToken) ||
    metadata.label !== SETHX_FEE_CONVERSION_LABEL ||
    metadata.description !== SETHX_FEE_CONVERSION_DESCRIPTION
  ) {
    const tx = await priceManager.setOracleMetadata(
      oracleAddress,
      sethxToken,
      SETHX_FEE_CONVERSION_LABEL,
      SETHX_FEE_CONVERSION_DESCRIPTION,
    );
    await tx.wait();
    actions.push("setOracleMetadata");
  }

  if (
    !(await priceManager.isOracleApprovedFor(
      oracleAddress,
      FEE_CONVERSION_CONTEXT,
    ))
  ) {
    const tx = await priceManager.approveOracleForContext(
      oracleAddress,
      FEE_CONVERSION_CONTEXT,
    );
    await tx.wait();
    actions.push("approveOracleForContext:FEE_CONVERSION");
  }

  if (!(await priceManager.tokenAllowedForContext(sethxToken, FEE_CONVERSION_CONTEXT))) {
    const tx = await priceManager.setTokenAllowedForContext(
      sethxToken,
      FEE_CONVERSION_CONTEXT,
      true,
    );
    await tx.wait();
    actions.push("setTokenAllowedForContext:SETHX:FEE_CONVERSION");
  }

  const registeredOracles = await priceManager.getOraclesForTokenContext(
    sethxToken,
    FEE_CONVERSION_CONTEXT,
  );
  if (!includesAddress(ethers, registeredOracles, oracleAddress)) {
    const tx = await priceManager.registerOracleForTokenContext(
      sethxToken,
      FEE_CONVERSION_CONTEXT,
      oracleAddress,
    );
    await tx.wait();
    actions.push("registerOracleForTokenContext:SETHX:FEE_CONVERSION");
  }

  const syncTx = await priceManager.syncOracleData(oracleAddress);
  await syncTx.wait();
  actions.push("syncOracleData");

  const [rate, oracle] = await priceManager.getFeeConversionRate(sethxToken);

  return {
    sethxFeeConversionOracle: {
      oracle: oracleAddress,
      token: sethxToken,
      context: "FEE_CONVERSION",
      tokenAllowed: await priceManager.tokenAllowedForContext(
        sethxToken,
        FEE_CONVERSION_CONTEXT,
      ),
      approvedForFeeConversion: await priceManager.isOracleApprovedFor(
        oracleAddress,
        FEE_CONVERSION_CONTEXT,
      ),
      usableForFeeConversion: await priceManager.isOracleUsableForFeeConversion(
        oracleAddress,
      ),
      registeredOracles: await priceManager.getOraclesForTokenContext(
        sethxToken,
        FEE_CONVERSION_CONTEXT,
      ),
      tokenPerEthE18: rate.toString(),
      resolvedOracle: oracle,
      expectedTokenPerEthE18:
        INITIAL_PROTOCOL_PARAMETERS.sethxFeeConversionOracle.sethxPerEth.toString(),
      oracleContractRate: (
        await sethxFeeConversionOracle.sethxPerEth()
      ).toString(),
      actions,
    },
  };
}
