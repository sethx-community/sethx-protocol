import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;

const OracleContext = {
  GENERAL: 0,
  TRADE_VALUE: 1,
  FUTURE_SETTLEMENT: 2,
  COLLATERAL_EVAL: 3,
  OPTION_SETTLEMENT: 4,
  FEE_CONVERSION: 5,
} as const;

type OracleContextName = keyof typeof OracleContext;

type DeploymentOutput = {
  environment?: string;
  chainId?: string | number | bigint;
  addresses?: Record<string, string>;
};

type TokenInput = {
  label: string;
  address: string;
};

// Edit this list for local/dev testing. CLI args are optional and are not required.
// You can use either a deployment address key, a raw address, or LABEL=address.
const HARDCODED_TOKENS = [
  "USDC=usdcToken",
  "WBTC=wbtcToken",
] as const;

// Default contexts for local/dev testing. You can still override/add contexts with --context
// if your Hardhat runner supports script args.
const HARDCODED_CONTEXTS: OracleContextName[] = [
  "GENERAL",
  "TRADE_VALUE",
  "FUTURE_SETTLEMENT",
  "COLLATERAL_EVAL",
  "OPTION_SETTLEMENT",
];

function parseArgs(argv: string[]) {
  const args = new Map<string, string[]>();

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const value = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
    const values = args.get(key) ?? [];
    values.push(value);
    args.set(key, values);
  }

  return {
    get(name: string, fallback?: string) {
      return args.get(name)?.at(-1) ?? fallback;
    },
    getAll(name: string) {
      return args.get(name) ?? [];
    },
    has(name: string) {
      return args.has(name);
    },
  };
}

function requireAddress(deployment: DeploymentOutput, key: string): string {
  const address = deployment.addresses?.[key];
  if (!address || !ethers.isAddress(address)) {
    throw new Error(`Missing deployment address: ${key}`);
  }
  return address;
}

function readDeployment(filePath: string): DeploymentOutput {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Deployment file not found: ${resolved}`);
  }

  const deployment = JSON.parse(fs.readFileSync(resolved, "utf8")) as DeploymentOutput;
  if (!deployment.addresses || typeof deployment.addresses !== "object") {
    throw new Error("Deployment file must contain an addresses object.");
  }
  return deployment;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseContexts(values: string[]): OracleContextName[] {
  const raw = values.length > 0 ? values : ["TRADE_VALUE"];
  const contexts = raw.flatMap((value) => value.split(",")).map((value) => value.trim().toUpperCase()).filter(Boolean);

  return contexts.map((context) => {
    if (!(context in OracleContext)) {
      throw new Error(`Unknown oracle context '${context}'. Valid: ${Object.keys(OracleContext).join(", ")}`);
    }
    return context as OracleContextName;
  });
}

function resolveToken(value: string, deployment: DeploymentOutput): TokenInput {
  const [maybeLabel, maybeAddress] = value.includes("=") ? value.split("=", 2) : [undefined, value];
  const raw = maybeAddress ?? value;

  if (ethers.isAddress(raw)) {
    return {
      label: maybeLabel || raw,
      address: ethers.getAddress(raw),
    };
  }

  const address = deployment.addresses?.[raw];
  if (address && ethers.isAddress(address)) {
    return {
      label: maybeLabel || raw,
      address: ethers.getAddress(address),
    };
  }

  throw new Error(`Token '${value}' is neither an address nor a key in deployment.addresses.`);
}

async function getPriceManagerSigner(priceManager: any, deployment: DeploymentOutput) {
  const [deployer] = await ethers.getSigners();
  const adminRole = await priceManager.DEFAULT_ADMIN_ROLE();

  if (await priceManager.hasRole(adminRole, deployer.address)) {
    return {
      signer: deployer,
      mode: `deployer admin ${deployer.address}`,
      stop: async () => {},
    };
  }

  const timelock = deployment.addresses?.sethxTimelock;
  const chainId = String(deployment.chainId ?? "");

  if (timelock && ethers.isAddress(timelock) && (await priceManager.hasRole(adminRole, timelock))) {
    if (chainId !== "31337") {
      throw new Error(
        `PriceManager admin is timelock ${timelock}. Direct impersonation is only allowed on local chain 31337; use governance on ${chainId}.`,
      );
    }

    await ethers.provider.send("hardhat_impersonateAccount", [timelock]);
    await ethers.provider.send("hardhat_setBalance", [timelock, "0x56BC75E2D63100000"]); // 100 ETH

    return {
      signer: await ethers.getSigner(timelock),
      mode: `local impersonated timelock ${timelock}`,
      stop: async () => {
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelock]);
      },
    };
  }

  throw new Error(
    `No usable PriceManager admin signer found. Deployer ${deployer.address} is not admin, and sethxTimelock is not an admin in the deployment file.`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const deploymentPath = args.get("deployment", "deployments/local/latest.json")!;
  const deployment = readDeployment(deploymentPath);
  const priceManagerAddress = requireAddress(deployment, "priceManager");
  const priceManager = await ethers.getContractAt("PriceManager", priceManagerAddress);

  const contextArgs = args.getAll("context");
  const contexts = contextArgs.length > 0 ? parseContexts(contextArgs) : HARDCODED_CONTEXTS;
  const allow = parseBool(args.get("allow"), true);
  const includeSethx = !args.has("no-sethx");
  const includeEth = args.has("include-eth");

  const tokenArgs = [...HARDCODED_TOKENS, ...args.getAll("token")];
  const tokenInputs = tokenArgs.map((value) => resolveToken(value, deployment));

  if (includeSethx && deployment.addresses?.sethxToken) {
    tokenInputs.unshift({ label: "sethxToken", address: ethers.getAddress(deployment.addresses.sethxToken) });
  }

  if (includeEth) {
    tokenInputs.unshift({ label: "ETH", address: ETH });
  }

  const unique = new Map<string, TokenInput>();
  for (const token of tokenInputs) unique.set(token.address.toLowerCase(), token);
  const tokens = [...unique.values()];

  if (tokens.length === 0) {
    throw new Error(
      [
        "No tokens supplied.",
        "Examples:",
        "Edit HARDCODED_TOKENS at the top of this script, then run:",
        "  npx hardhat run scripts/dev/whitelist-price-manager-tokens.ts --network localhost",
      ].join("\n"),
    );
  }

  const admin = await getPriceManagerSigner(priceManager, deployment);
  console.log(`[whitelist] PriceManager: ${priceManagerAddress}`);
  console.log(`[whitelist] Admin mode: ${admin.mode}`);
  console.log(`[whitelist] Contexts: ${contexts.join(", ")}`);
  console.log(`[whitelist] Allowed: ${allow}`);

  try {
    const connected = priceManager.connect(admin.signer);

    for (const token of tokens) {
      for (const contextName of contexts) {
        const context = OracleContext[contextName];
        const current = await priceManager.tokenAllowedForContext(token.address, context);

        if (current === allow) {
          console.log(`skip ${token.label} ${token.address} ${contextName}: already ${allow ? "allowed" : "blocked"}`);
          continue;
        }

        const tx = await connected.setTokenAllowedForContext(token.address, context, allow);
        const receipt = await tx.wait();
        console.log(`ok ${token.label} ${token.address} ${contextName}: ${allow ? "allowed" : "blocked"} gas=${receipt?.gasUsed?.toString() ?? "?"}`);
      }
    }
  } finally {
    await admin.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
