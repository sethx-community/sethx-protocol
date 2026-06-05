# SETHX staged deployment guide

Use the staged runner for testnet and mainnet deployments. Do not use `scripts/run-deployment.ts` for mainnet because it performs token deployment and distribution in one run without the manual inspection step between stages.

## Required environment variables

### Testnet

```bash
SETHX_DEPLOYMENT_ENVIRONMENT=testnet
SETHX_TESTNET_CHAIN_ID=<chain id, for example 11155111 for Sepolia>
SETHX_FOUNDER_1_ADDRESS=0x...
SETHX_FOUNDER_2_ADDRESS=0x...
SETHX_FOUNDER_3_ADDRESS=0x...
```

Also configure the Hardhat network RPC URL and deployer private key using the variable names expected by your `hardhat.config.ts`. The deployment config in this folder validates the expected chain id and founder addresses, but the actual RPC/private-key network setup normally lives in Hardhat config.

### Mainnet

```bash
SETHX_DEPLOYMENT_ENVIRONMENT=mainnet
SETHX_CONFIRM_MAINNET_DEPLOYMENT=I_UNDERSTAND_THIS_DEPLOYS_TO_MAINNET
SETHX_FOUNDER_1_ADDRESS=0x...
SETHX_FOUNDER_2_ADDRESS=0x...
SETHX_FOUNDER_3_ADDRESS=0x...
```

Mainnet config rejects the zero address and common local Hardhat addresses for founders.

## Token and founder timelock deployment

Run only stage `00` first. This deploys the token, six founder timelocks, TreasuryAuthority, and ProtocolTreasury, but does not mint/distribute yet.

```bash
SETHX_DEPLOYMENT_STAGE=00 npx hardhat run scripts/run-stage.ts --network <testnet-network-name>
```

On Windows PowerShell:

```powershell
$env:SETHX_DEPLOYMENT_ENVIRONMENT="testnet"
$env:SETHX_TESTNET_CHAIN_ID="11155111"
$env:SETHX_DEPLOYMENT_STAGE="00"
npx hardhat run scripts/run-stage.ts --network <testnet-network-name>
```

Inspect `deployments/testnet/latest.json` before stage `10`.

Check:

- `addresses.sethxToken` exists.
- `addresses.protocolTreasury` exists.
- `addresses.founderTokenTimelocks` has exactly six entries.
- Each founder has two timelocks.
- Each timelock has `allocationBps = 300`.
- Each timelock allocation is `30,000,000 SETHX` in 18-decimal units.
- Release delays are two years and five years.
- Beneficiaries are exactly the intended founder addresses.

Then run stage `10`. This mints 18% to founder timelocks, 82% to treasury, and finishes minting.

```bash
SETHX_DEPLOYMENT_STAGE=10 npx hardhat run scripts/run-stage.ts --network <testnet-network-name>
```

Verify after stage `10`:

```bash
npx hardhat run scripts/verify/verify-token-distribution.ts --network <testnet-network-name>
```

## Mainnet sequence

Use the same two-stage sequence on mainnet:

1. Run stage `00`.
2. Inspect `deployments/mainnet/latest.json` carefully.
3. Verify founder beneficiaries and release times.
4. Run stage `10` only after confirming the output.
5. Run `scripts/verify/verify-token-distribution.ts`.

Do not delete or overwrite `deployments/mainnet/latest.json`. Keep a committed/offline copy after each stage.
