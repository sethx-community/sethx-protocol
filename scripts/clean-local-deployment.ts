import fs from "node:fs";
import path from "node:path";

async function main() {
  const deploymentDir = path.join(process.cwd(), "deployments", "local");
  const latestPath = path.join(deploymentDir, "latest.json");

  if (!fs.existsSync(latestPath)) {
    console.log("No local deployment found at deployments/local/latest.json");
    return;
  }

  fs.unlinkSync(latestPath);

  console.log("Removed deployments/local/latest.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
