import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

const { ethers } = await network.create();

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

type ImportedToken = {
  symbol: string;
  address: string;
  key: string;
  category?: string;
  volume30dUsd?: number;
  trades30d?: number;
};

const DEFAULT_CONTEXTS: OracleContextName[] = ["GENERAL"];

// This script only registers token trust in PriceManager. It does not approve
// treasury spending and does not configure valuation oracles. Use GENERAL for
// identity/trust listing; use TRADE_VALUE only when a trade-price oracle is
// intentionally configured and usable.

function parseArgs(argv: string[]) {
  const args = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
    const values = args.get(key) ?? [];
    values.push(value);
    args.set(key, values);
  }

  const env = process.env;
  const envContexts = env.SETHX_TOKEN_CONTEXTS ?? env.TOKEN_WHITELIST_CONTEXTS ?? env.SETHX_TOKEN_CONTEXT ?? env.TOKEN_WHITELIST_CONTEXT;
  const cliContexts = args.get("context") ?? [];
  const contextValues = cliContexts.length > 0 ? cliContexts : envContexts ? [envContexts] : [];
  const positionalJson = positionals.find(isLikelyJsonPath);

  return {
    input:
      args.get("json")?.at(-1) ??
      args.get("input")?.at(-1) ??
      env.SETHX_TOKEN_JSON ??
      env.TOKEN_WHITELIST_JSON ??
      positionalJson,
    deployment:
      args.get("deployment")?.at(-1) ??
      env.SETHX_DEPLOYMENT_JSON ??
      env.TOKEN_WHITELIST_DEPLOYMENT ??
      "deployments/local/latest.json",
    contexts: parseContexts(contextValues),
    allow: parseBool(args.get("allow")?.at(-1) ?? env.SETHX_TOKEN_ALLOW ?? env.TOKEN_WHITELIST_ALLOW, true),
    mode: args.get("mode")?.at(-1) ?? env.SETHX_TOKEN_MODE ?? env.TOKEN_WHITELIST_MODE ?? "auto",
    limit: parseNumber(args.get("limit")?.at(-1) ?? env.SETHX_TOKEN_LIMIT ?? env.TOKEN_WHITELIST_LIMIT),
    minVolumeUsd: parseNumber(args.get("min-volume-usd")?.at(-1) ?? env.SETHX_TOKEN_MIN_VOLUME_USD ?? env.TOKEN_WHITELIST_MIN_VOLUME_USD),
    minTrades30d: parseNumber(args.get("min-trades-30d")?.at(-1) ?? env.SETHX_TOKEN_MIN_TRADES_30D ?? env.TOKEN_WHITELIST_MIN_TRADES_30D),
    out:
      args.get("out")?.at(-1) ??
      env.SETHX_TOKEN_OUT ??
      env.TOKEN_WHITELIST_OUT ??
      "deployments/token-whitelist-price-manager-calls.json",
  };
}


function isLikelyJsonPath(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (normalized === "run") return false;
  if (normalized.endsWith(".ts") || normalized.endsWith(".js")) return false;
  return normalized.endsWith(".json");
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${value}`);
  return n;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseContexts(values: string[]): OracleContextName[] {
  const raw = values.length > 0 ? values : DEFAULT_CONTEXTS;
  const contexts = raw.flatMap((value) => value.split(",")).map((value) => value.trim().toUpperCase()).filter(Boolean);

  return contexts.map((context) => {
    if (!(context in OracleContext)) {
      throw new Error(`Unknown oracle context '${context}'. Valid: ${Object.keys(OracleContext).join(", ")}`);
    }
    return context as OracleContextName;
  });
}

function usage() {
  return [
    "Usage with Hardhat 3 / safe env mode:",
    "  SETHX_TOKEN_JSON=./tokens.json SETHX_DEPLOYMENT_JSON=deployments/<env>/latest.json SETHX_TOKEN_CONTEXTS=GENERAL npx hardhat run scripts/dev/whitelist-price-manager-tokens-from-json.ts --network <network>",
    "",
    "Usage with CLI args, only if your Hardhat version forwards script args:",
    "  npx hardhat run scripts/dev/whitelist-price-manager-tokens-from-json.ts --network <network> -- --json ./tokens.json --deployment deployments/<env>/latest.json",
    "",
    "Options / env vars:",
    "  --json <file>              Dune-style JSON export. Env: SETHX_TOKEN_JSON",
    "  --deployment <file>        Deployment latest.json path. Env: SETHX_DEPLOYMENT_JSON. Default: deployments/local/latest.json",
    "  --context <name[,name]>    PriceManager trust context(s). Env: SETHX_TOKEN_CONTEXTS. Default: GENERAL",
    "  --allow <true|false>       Allow/block flag. Env: SETHX_TOKEN_ALLOW. Default: true",
    "  --mode <auto|send|calldata> Env: SETHX_TOKEN_MODE. auto sends only if signer can admin PriceManager; otherwise writes calldata JSON.",
    "  --out <file>               Calldata JSON output path. Env: SETHX_TOKEN_OUT. Default: deployments/token-whitelist-price-manager-calls.json",
    "  --limit <n>                Use at most n rows after filtering. Env: SETHX_TOKEN_LIMIT",
    "  --min-volume-usd <n>       Skip rows below this 30d volume. Env: SETHX_TOKEN_MIN_VOLUME_USD",
    "  --min-trades-30d <n>       Skip rows below this 30d trade count. Env: SETHX_TOKEN_MIN_TRADES_30D",
  ].join("\n");
}

function readDeployment(filePath: string): DeploymentOutput {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Deployment file not found: ${resolved}`);
  const deployment = JSON.parse(fs.readFileSync(resolved, "utf8")) as DeploymentOutput;
  if (!deployment.addresses || typeof deployment.addresses !== "object") {
    throw new Error("Deployment file must contain an addresses object.");
  }
  return deployment;
}

function requireAddress(deployment: DeploymentOutput, key: string): string {
  const address = deployment.addresses?.[key];
  if (!address || !ethers.isAddress(address)) throw new Error(`Missing deployment address: ${key}`);
  return ethers.getAddress(address);
}

function readRows(inputPath: string): unknown[] {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Input JSON not found: ${resolved}`);
  const json = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(json?.result?.rows)
      ? json.result.rows
      : Array.isArray(json?.rows)
        ? json.rows
        : undefined;

  if (!rows) throw new Error("Could not find token rows. Expected an array, rows[], or result.rows[].");
  return rows;
}

function cleanSymbol(value: unknown): string {
  const raw = String(value ?? "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._+-]/g, "").slice(0, 24);
  return (cleaned || "TOKEN").toUpperCase();
}

function rowToToken(row: any): ImportedToken | undefined {
  const rawAddress = row?.contract_address ?? row?.address ?? row?.token_address ?? row?.token;
  if (!rawAddress || !ethers.isAddress(rawAddress)) return undefined;

  const address = ethers.getAddress(rawAddress);
  const volume = Number(row.volume_30d_usd ?? row.volume_usd ?? row.volume ?? 0);
  const trades = Number(row.total_trades_30d ?? row.trades_30d ?? row.trades ?? 0);

  return {
    symbol: cleanSymbol(row.token_symbol ?? row.symbol ?? row.ticker ?? "TOKEN"),
    address,
    key: address.toLowerCase(),
    category: String(row.qualification_category ?? row.category ?? "Imported"),
    volume30dUsd: Number.isFinite(volume) ? volume : 0,
    trades30d: Number.isFinite(trades) ? trades : 0,
  };
}

function parseTokens(inputPath: string, options: { limit?: number; minVolumeUsd?: number; minTrades30d?: number }): ImportedToken[] {
  const seen = new Set<string>();
  const tokens: ImportedToken[] = [];

  for (const row of readRows(inputPath)) {
    const token = rowToToken(row);
    if (!token) continue;
    if (options.minVolumeUsd !== undefined && (token.volume30dUsd ?? 0) < options.minVolumeUsd) continue;
    if (options.minTrades30d !== undefined && (token.trades30d ?? 0) < options.minTrades30d) continue;
    if (seen.has(token.key)) continue;

    seen.add(token.key);
    tokens.push(token);
    if (options.limit !== undefined && tokens.length >= options.limit) break;
  }

  if (tokens.length === 0) throw new Error("No valid token rows found after filtering.");
  return tokens;
}

async function canAdmin(priceManager: any, signerAddress: string): Promise<boolean> {
  const adminRole = await priceManager.DEFAULT_ADMIN_ROLE();
  return priceManager.hasRole(adminRole, signerAddress);
}

async function maybeLocalTimelockSigner(priceManager: any, deployment: DeploymentOutput) {
  const timelock = deployment.addresses?.sethxTimelock;
  const chainId = String(deployment.chainId ?? "");
  if (!timelock || !ethers.isAddress(timelock) || chainId !== "31337") return undefined;
  if (!(await canAdmin(priceManager, timelock))) return undefined;

  await ethers.provider.send("hardhat_impersonateAccount", [timelock]);
  await ethers.provider.send("hardhat_setBalance", [timelock, "0x56BC75E2D63100000"]); // 100 ETH

  return {
    signer: await ethers.getSigner(timelock),
    mode: `local impersonated timelock ${timelock}`,
    stop: async () => ethers.provider.send("hardhat_stopImpersonatingAccount", [timelock]),
  };
}

function buildCalldata(priceManager: any, priceManagerAddress: string, tokens: ImportedToken[], contexts: OracleContextName[], allow: boolean) {
  const calls: Array<{ target: string; value: string; data: string; label: string; token: string; context: OracleContextName; allow: boolean }> = [];

  for (const token of tokens) {
    for (const contextName of contexts) {
      const context = OracleContext[contextName];
      calls.push({
        target: priceManagerAddress,
        value: "0",
        data: priceManager.interface.encodeFunctionData("setTokenAllowedForContext", [token.address, context, allow]),
        label: `${allow ? "Trust" : "Untrust"} ${token.symbol} ${contextName}`,
        token: token.address,
        context: contextName,
        allow,
      });
    }
  }

  return calls;
}

async function writeCalldataOutput(filePath: string, payload: unknown) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[whitelist-json] Wrote calldata output: ${resolved}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error(usage());
    console.error('\nMissing token JSON. In PowerShell, run: $env:SETHX_TOKEN_JSON="./tokens.json" before running Hardhat.');
    process.exitCode = 1;
    return;
  }

  if (!["auto", "send", "calldata"].includes(args.mode)) {
    throw new Error("--mode must be auto, send, or calldata");
  }

  const deployment = readDeployment(args.deployment);
  const priceManagerAddress = requireAddress(deployment, "priceManager");
  const priceManager = await ethers.getContractAt("PriceManager", priceManagerAddress);
  const tokens = parseTokens(args.input, args);
  const [deployer] = await ethers.getSigners();

  console.log(`[whitelist-json] PriceManager: ${priceManagerAddress}`);
  console.log(`[whitelist-json] Tokens: ${tokens.length}`);
  console.log(`[whitelist-json] Contexts: ${args.contexts.join(", ")}`);
  console.log(`[whitelist-json] Allow: ${args.allow}`);

  const calls = buildCalldata(priceManager, priceManagerAddress, tokens, args.contexts, args.allow);

  if (args.mode === "calldata") {
    await writeCalldataOutput(args.out, {
      generatedAt: new Date().toISOString(),
      deployment: args.deployment,
      priceManager: priceManagerAddress,
      contexts: args.contexts,
      allow: args.allow,
      calls,
    });
    return;
  }

  let admin: { signer: any; mode: string; stop: () => Promise<unknown> } | undefined;

  if (await canAdmin(priceManager, deployer.address)) {
    admin = { signer: deployer, mode: `deployer admin ${deployer.address}`, stop: async () => undefined };
  } else {
    admin = await maybeLocalTimelockSigner(priceManager, deployment);
  }

  if (!admin) {
    if (args.mode === "send") {
      throw new Error(
        `Cannot send directly: deployer ${deployer.address} is not PriceManager admin. Use --mode calldata and propose through governance/timelock.`,
      );
    }

    await writeCalldataOutput(args.out, {
      generatedAt: new Date().toISOString(),
      deployment: args.deployment,
      priceManager: priceManagerAddress,
      contexts: args.contexts,
      allow: args.allow,
      reason: `Deployer ${deployer.address} is not PriceManager admin; use these calls in governance/timelock.`,
      calls,
    });
    return;
  }

  console.log(`[whitelist-json] Sending with ${admin.mode}`);

  try {
    const connected = priceManager.connect(admin.signer);
    for (const token of tokens) {
      for (const contextName of args.contexts) {
        const context = OracleContext[contextName];
        const current = await priceManager.tokenAllowedForContext(token.address, context);
        if (current === args.allow) {
          console.log(`skip ${token.symbol} ${token.address} ${contextName}: already ${args.allow ? "trusted" : "untrusted"}`);
          continue;
        }

        const tx = await connected.setTokenAllowedForContext(token.address, context, args.allow);
        const receipt = await tx.wait();
        console.log(`ok ${token.symbol} ${token.address} ${contextName}: ${args.allow ? "trusted" : "untrusted"} gas=${receipt?.gasUsed?.toString() ?? "?"}`);
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
