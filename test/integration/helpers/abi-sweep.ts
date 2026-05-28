import { expect } from "chai";

export interface SweepTarget {
  key: string;
  contractName: string;
  address: string;
  contract: any;
}

export interface SweepAllowance {
  contractName?: string;
  functionName?: string;
  signature?: string;
  reason: string;
}

export interface SweepResult {
  target: string;
  contractName: string;
  address: string;
  signature: string;
  selector: string;
  outcome: "reverted" | "allowed-success" | "allowed-revert" | "unexpected-success";
  allowanceReason?: string;
  error?: string;
}

function fragmentSignature(fragment: any): string {
  return fragment.format("sighash");
}

function isAllowed(
  target: SweepTarget,
  fragment: any,
  allowances: readonly SweepAllowance[],
): SweepAllowance | undefined {
  const signature = fragmentSignature(fragment);

  return allowances.find((allowance) => {
    if (allowance.contractName && allowance.contractName !== target.contractName) {
      return false;
    }

    if (allowance.signature && allowance.signature !== signature) {
      return false;
    }

    if (allowance.functionName && allowance.functionName !== fragment.name) {
      return false;
    }

    return true;
  });
}

function zeroBytes(length: number): string {
  return `0x${"00".repeat(length)}`;
}

function dummyValueForType(ethers: any, param: any, attackerAddress: string): any {
  const baseType = param.baseType ?? param.type;
  const type = param.type as string;

  if (baseType === "array") {
    if (type.includes("[")) {
      const match = type.match(/\[(\d+)\]$/);
      const fixedLength = match ? Number(match[1]) : 0;
      return Array.from({ length: fixedLength }, () =>
        dummyValueForType(ethers, param.arrayChildren, attackerAddress),
      );
    }

    return [];
  }

  if (baseType === "tuple") {
    return param.components.map((component: any) =>
      dummyValueForType(ethers, component, attackerAddress),
    );
  }

  if (type === "address") return attackerAddress;
  if (type === "bool") return false;
  if (type === "string") return "malicious-sweep";
  if (type === "bytes") return "0x";
  if (type === "bytes32") return ethers.ZeroHash;

  const bytesMatch = type.match(/^bytes(\d+)$/);
  if (bytesMatch) return zeroBytes(Number(bytesMatch[1]));

  if (type.startsWith("uint") || type.startsWith("int")) return 1n;

  throw new Error(`Unsupported ABI parameter type for sweep: ${type}`);
}

export function mutatingFragments(contract: any): any[] {
  return contract.interface.fragments
    .filter((fragment: any) => fragment.type === "function")
    .filter(
      (fragment: any) =>
        fragment.stateMutability !== "view" && fragment.stateMutability !== "pure",
    )
    .sort((a: any, b: any) => fragmentSignature(a).localeCompare(fragmentSignature(b)));
}

export async function maliciousCallSweep(options: {
  ethers: any;
  targets: readonly SweepTarget[];
  attacker: any;
  allowances?: readonly SweepAllowance[];
}): Promise<SweepResult[]> {
  const { ethers, targets, attacker, allowances = [] } = options;
  const attackerAddress = await attacker.getAddress();
  const results: SweepResult[] = [];

  for (const target of targets) {
    for (const fragment of mutatingFragments(target.contract)) {
      const signature = fragmentSignature(fragment);
      const selector = target.contract.interface.getFunction(signature).selector;
      const allowance = isAllowed(target, fragment, allowances);
      const args = fragment.inputs.map((param: any) =>
        dummyValueForType(ethers, param, attackerAddress),
      );
      const data = target.contract.interface.encodeFunctionData(fragment, args);

      const snapshotId = await ethers.provider.send("evm_snapshot", []);

      try {
        const tx = await attacker.sendTransaction({
          to: target.address,
          data,
          value: 0n,
        });
        await tx.wait();

        results.push({
          target: target.key,
          contractName: target.contractName,
          address: target.address,
          signature,
          selector,
          outcome: allowance ? "allowed-success" : "unexpected-success",
          allowanceReason: allowance?.reason,
        });
      } catch (error: any) {
        results.push({
          target: target.key,
          contractName: target.contractName,
          address: target.address,
          signature,
          selector,
          outcome: allowance ? "allowed-revert" : "reverted",
          allowanceReason: allowance?.reason,
          error: error?.message ?? String(error),
        });
      } finally {
        await ethers.provider.send("evm_revert", [snapshotId]);
      }
    }
  }

  const unexpectedSuccesses = results.filter(
    (result) => result.outcome === "unexpected-success",
  );

  expect(
    unexpectedSuccesses,
    [
      "Unexpected successful attacker calls. Add a justified allowance only for intentionally public functions, or fix the access guard:",
      ...unexpectedSuccesses.map(
        (result) =>
          `${result.target} ${result.contractName}.${result.signature} selector=${result.selector} address=${result.address}`,
      ),
    ].join("\n"),
  ).to.deep.equal([]);

  return results;
}
