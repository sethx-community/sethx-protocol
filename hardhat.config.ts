import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.mainnet", override: true });

import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL;
const mainnetRpcUrl = process.env.MAINNET_RPC_URL;
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY;
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

const accounts = deployerPrivateKey ? [deployerPrivateKey] : [];

const networks: any = {
  hardhat: {
    type: "edr-simulated",
    chainId: 31337,
    blockGasLimit: 60_000_000,
    gasMultiplier: 1,
  },
  localhost: {
    type: "http",
    url: "http://127.0.0.1:8545",
  },
};

if (sepoliaRpcUrl) {
  networks.sepolia = {
    type: "http",
    url: sepoliaRpcUrl,
    accounts,
    chainId: 11155111,
  };
}

if (mainnetRpcUrl) {
  networks.mainnet = {
    type: "http",
    url: mainnetRpcUrl,
    accounts,
    chainId: 1,
  };
}

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, hardhatVerify],

  solidity: {
    profiles: {
      default: {
        compilers: [
          {
            version: "0.8.26",
            settings: {
              optimizer: { enabled: true, runs: 200 },
              viaIR: true,
            },
          },
        ],
      },
      production: {
        compilers: [
          {
            version: "0.8.26",
            settings: {
              optimizer: { enabled: true, runs: 200 },
              viaIR: true,
            },
          },
        ],
      },
    },
  },

  networks,

  // --- REALIGNED HARDHAT 3 VERIFICATION PATTERN ---
  verify: {
    etherscan: {
      apiKey: etherscanApiKey || "",
    },
    sourcify: {
      enabled: true,
    },
  },
});
