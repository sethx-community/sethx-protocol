#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const stages = [
  "00",
  "10",
  "20",
  "21",
  "30",
  "40",
  "41",
  "42",
  "50",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "59",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "67",
  "68",
  "69",
  "70",
  "71",
  "72",
  "73",
  "74",
  "75",
  "76",
  "77",
  "78",
  "79",
  "80",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
  "87",
  "88",
  "89",
];

const args = new Set(process.argv.slice(2));
const shouldClean = args.has("--fresh") || args.has("--clean");
const shell = process.platform === "win32";

function cleanLocalDeploymentOutput() {
  const fs = require("node:fs");
  const path = require("node:path");
  const outputDir = path.join(process.cwd(), "deployments", "local");

  if (!fs.existsSync(outputDir)) {
    console.log("No local deployment output directory found at deployments/local");
    return;
  }

  let removed = 0;
  for (const entry of fs.readdirSync(outputDir)) {
    if (!entry.endsWith(".json")) continue;
    fs.unlinkSync(path.join(outputDir, entry));
    removed += 1;
  }

  console.log(
    removed === 0
      ? "No local deployment JSON files found in deployments/local"
      : `Removed ${removed} local deployment JSON file(s) from deployments/local`,
  );
}

function assertLocalOracleDeploymentOutput() {
  const fs = require("node:fs");
  const path = require("node:path");
  const latestPath = path.join(process.cwd(), "deployments", "local", "latest.json");
  const required = [
    "usdcToken",
    "wbtcToken",
    "usdcEthFeed",
    "wbtcEthFeed",
    "usdcEthOracle",
    "wbtcEthOracle",
  ];

  const deployment = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  const missing = required.filter((key) => !deployment.addresses?.[key]);
  if (missing.length > 0) {
    throw new Error(
      `Local deployment is missing token/ETH oracle output(s): ${missing.join(", ")}`,
    );
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell,
    env: process.env,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (shouldClean) {
  console.log("\n==> Cleaning local deployment output");
  cleanLocalDeploymentOutput();
}

for (const stage of stages) {
  console.log(`\n==> Running local deployment stage ${stage}`);
  run("npm", ["run", `deploy:local:${stage}`]);
}

assertLocalOracleDeploymentOutput();
console.log("\n==> Local deployment complete through stage 89");
