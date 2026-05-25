import fs from "node:fs";
import path from "node:path";

export interface LocalDeploymentOutput {
  environment: "local";
  chainId: string;
  deployedAt: string;
  founderAddress: string;
  founderReleaseTime: string;
  addresses: {
    sethxToken: string;
    founderTokenTimelock: string;
    treasuryAuthority: string;
    protocolTreasury: string;
  };
  tokenDistribution: {
    totalSupply: string;
    founderAmount: string;
    treasuryAmount: string;
  };
}

export function readLocalDeployment(): LocalDeploymentOutput {
  const deploymentPath = path.join(
    process.cwd(),
    "deployments",
    "local",
    "latest.json",
  );

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "Missing deployments/local/latest.json. Run npm run deploy:local before running local integration tests.",
    );
  }

  return JSON.parse(
    fs.readFileSync(deploymentPath, "utf8"),
  ) as LocalDeploymentOutput;
}
