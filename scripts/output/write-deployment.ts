import fs from "node:fs";
import path from "node:path";

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

export function writeDeploymentOutput(
  outputDir: string,
  output: Record<string, unknown>,
) {
  fs.mkdirSync(outputDir, { recursive: true });

  const latestPath = path.join(outputDir, "latest.json");

  fs.writeFileSync(
    latestPath,
    JSON.stringify(output, jsonReplacer, 2) + "\n",
    "utf8",
  );

  console.log(`Deployment output written to ${latestPath}`);
}
