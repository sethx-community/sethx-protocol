import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

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

  networks: {
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
  },
});
