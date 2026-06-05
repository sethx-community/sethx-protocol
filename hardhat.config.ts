import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL;
const mainnetRpcUrl = process.env.MAINNET_RPC_URL;
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY;

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
  plugins: [hardhatToolboxMochaEthers],

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
});
