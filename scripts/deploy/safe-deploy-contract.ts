type DeployOptions = {
  gasLimitMultiplierBps?: bigint;
};

function normalizePrivateKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function waitForRawDeploymentReceipt(provider: any, txHash: string) {
  for (;;) {
    const receipt = await provider.send("eth_getTransactionReceipt", [txHash]);

    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(`Deployment transaction failed: ${txHash}`);
      }

      if (!receipt.contractAddress) {
        throw new Error(`Deployment transaction has no contractAddress: ${txHash}`);
      }

      return receipt;
    }

    await new Promise((resolve) => setTimeout(resolve, 12_000));
  }
}

async function deployWithRawTransaction(
  ethers: any,
  contractName: string,
  args: readonly unknown[],
  options: DeployOptions = {},
) {
  const privateKey = normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY ?? "");

  if (!privateKey) {
    throw new Error(
      `DEPLOYER_PRIVATE_KEY is required for raw deployment of ${contractName}`,
    );
  }

  const provider = ethers.provider;
  const wallet = new ethers.Wallet(privateKey);
  const deployerAddress = await wallet.getAddress();

  const factory = await ethers.getContractFactory(contractName);
  const deployTx = await factory.getDeployTransaction(...args);

  if (!deployTx.data) {
    throw new Error(`Missing deployment data for ${contractName}`);
  }

  const nonceHex = await provider.send("eth_getTransactionCount", [
    deployerAddress,
    "pending",
  ]);
  const nonce = Number(BigInt(nonceHex));

  const predictedAddress = ethers.getCreateAddress({
    from: deployerAddress,
    nonce,
  });

  const feeData = await provider.getFeeData();
  const gasEstimate = await provider.estimateGas({
    from: deployerAddress,
    data: deployTx.data,
    value: deployTx.value ?? 0n,
  });

  const multiplier = options.gasLimitMultiplierBps ?? 12_000n;
  const gasLimit = (gasEstimate * multiplier) / 10_000n;

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) {
    throw new Error(`Could not determine maxFeePerGas for ${contractName}`);
  }

  const tx = {
    type: 2,
    chainId: (await provider.getNetwork()).chainId,
    nonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
    data: deployTx.data,
    value: deployTx.value ?? 0n,
  };

  const signed = await wallet.signTransaction(tx);
  const hash = await provider.send("eth_sendRawTransaction", [signed]);

  console.log(`${contractName} deployment sent: ${hash}`);
  console.log(`${contractName} predicted address: ${predictedAddress}`);

  const receipt = await waitForRawDeploymentReceipt(provider, hash);
  const deployedAddress = ethers.getAddress(receipt.contractAddress);

  if (deployedAddress.toLowerCase() !== predictedAddress.toLowerCase()) {
    throw new Error(
      `${contractName} address mismatch. Predicted ${predictedAddress}, receipt ${deployedAddress}`,
    );
  }

  console.log(`${contractName} deployed: ${deployedAddress}`);

  return ethers.getContractAt(contractName, deployedAddress);
}

export async function safeDeployContract(
  ethers: any,
  contractName: string,
  args: readonly unknown[] = [],
  options: DeployOptions = {},
) {
  const chain = await ethers.provider.getNetwork();
  const shouldUseRawDeployment =
    chain.chainId !== 31337n && Boolean(process.env.DEPLOYER_PRIVATE_KEY);

  if (shouldUseRawDeployment) {
    return deployWithRawTransaction(ethers, contractName, args, options);
  }

  const contract = await ethers.deployContract(contractName, args);
  return contract;
}
