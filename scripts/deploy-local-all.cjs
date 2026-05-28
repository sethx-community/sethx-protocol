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
  const latestPath = path.join(
    process.cwd(),
    "deployments",
    "local",
    "latest.json",
  );

  if (!fs.existsSync(latestPath)) {
    console.log("No local deployment found at deployments/local/latest.json");
    return;
  }

  fs.unlinkSync(latestPath);
  console.log("Removed deployments/local/latest.json");
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

console.log("\n==> Local deployment complete through stage 89");
