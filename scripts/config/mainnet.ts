import { getAddress, ZeroAddress } from "ethers";

const MAINNET_CONFIRMATION = "I_UNDERSTAND_THIS_DEPLOYS_TO_MAINNET";

const KNOWN_LOCAL_ADDRESSES = new Set(
  [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  ].map((address) => address.toLowerCase()),
);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function requireMainnetAddress(name: string): string {
  const value = getAddress(requireEnv(name));

  if (value === ZeroAddress) {
    throw new Error(`${name} cannot be the zero address`);
  }

  if (KNOWN_LOCAL_ADDRESSES.has(value.toLowerCase())) {
    throw new Error(`${name} cannot be a known local Hardhat address`);
  }

  return value;
}

export function getMainnetDeploymentConfig() {
  const confirmation = requireEnv("SETHX_CONFIRM_MAINNET_DEPLOYMENT");

  if (confirmation !== MAINNET_CONFIRMATION) {
    throw new Error("Mainnet deployment confirmation is missing or incorrect");
  }

  return {
    environment: "mainnet",
    expectedChainId: 1n,
    outputDir: "deployments/mainnet",
    founderAddresses: [
      requireMainnetAddress("SETHX_FOUNDER_1_ADDRESS"),
      requireMainnetAddress("SETHX_FOUNDER_2_ADDRESS"),
      requireMainnetAddress("SETHX_FOUNDER_3_ADDRESS"),
    ],
  } as const;
}
