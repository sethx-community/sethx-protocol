const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const folder = process.argv[2];
const network = process.argv[3] ?? "localhost";

if (!folder) {
  console.error(
    "Usage: node scripts/run-tests-by-folder.cjs <folder> [network]",
  );
  process.exit(1);
}

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
      continue;
    }

    const isTypeScriptTest =
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts");

    const isHelperFile = fullPath.includes(`${path.sep}helpers${path.sep}`);

    if (isTypeScriptTest && !isHelperFile) {
      files.push(fullPath);
    }
  }

  return files;
}

const root = path.resolve(folder);

if (!fs.existsSync(root)) {
  console.error(`Test folder does not exist: ${root}`);
  process.exit(1);
}

const files = collectTests(root).map((file) =>
  path.relative(process.cwd(), file).replace(/\\/g, "/"),
);

if (files.length === 0) {
  console.error(`No test files found in ${root}`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) on network ${network}:`);
for (const file of files) {
  console.log(`- ${file}`);
}

let result;

if (process.platform === "win32") {
  const commandLine = [
    "npx",
    "hardhat",
    "test",
    "--network",
    network,
    ...files,
  ].join(" ");

  console.log("");
  console.log(`Command: ${commandLine}`);
  console.log("");

  result = spawnSync("cmd.exe", ["/d", "/c", commandLine], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
} else {
  const hardhatBin = path.resolve("node_modules", ".bin", "hardhat");
  const args = ["test", "--network", network, ...files];

  console.log("");
  console.log(`Command: ${hardhatBin} ${args.join(" ")}`);
  console.log("");

  result = spawnSync(hardhatBin, args, {
    stdio: "inherit",
    shell: false,
    cwd: process.cwd(),
    env: process.env,
  });
}

if (result.error) {
  console.error("Failed to start Hardhat:");
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  console.error(`Hardhat exited with signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
