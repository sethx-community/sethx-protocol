import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

async function grantIfMissing(contract: any, role: string, target: string) {
  if (!(await contract.hasRole(role, target))) {
    const tx = await contract.grantRole(role, target);
    await tx.wait();
  }
}

function toBigIntValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return BigInt(value.toString());
  }

  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function combinePermissionBits(values: unknown[]): bigint {
  return values.reduce<bigint>(
    (combined, value) => combined | toBigIntValue(value),
    0n,
  );
}


async function setVaultProtocolTreasuryIfNeeded(
  vault: any,
  protocolTreasuryAddress: string,
) {
  if ((await vault.protocolTreasury()) !== protocolTreasuryAddress) {
    const tx = await vault.setProtocolTreasury(protocolTreasuryAddress);
    await tx.wait();
  }
}

async function setApprovedTreasuryModuleIfNeeded(
  protocolTreasury: any,
  module: string,
  allowed: boolean,
) {
  if ((await protocolTreasury.approvedTreasuryModules(module)) !== allowed) {
    const tx = await protocolTreasury.setApprovedTreasuryModule(
      module,
      allowed,
    );
    await tx.wait();
  }
}

async function setApprovedInternalReceiverIfNeeded(
  protocolTreasury: any,
  receiver: string,
  allowed: boolean,
) {
  if (
    (await protocolTreasury.approvedInternalReceivers(receiver)) !== allowed
  ) {
    const tx = await protocolTreasury.setApprovedInternalReceiver(
      receiver,
      allowed,
    );
    await tx.wait();
  }
}

async function setApprovedExternalRecipientIfNeeded(
  protocolTreasury: any,
  recipient: string,
  allowed: boolean,
) {
  if (
    (await protocolTreasury.approvedExternalRecipients(recipient)) !== allowed
  ) {
    const tx = await protocolTreasury.setApprovedExternalRecipient(
      recipient,
      allowed,
    );
    await tx.wait();
  }
}

async function setPaymentBudgetIfNeeded(
  treasuryPaymentsModule: any,
  recipient: string,
  token: string,
  monthlyLimit: bigint,
  approved: boolean,
) {
  const budget = await treasuryPaymentsModule.paymentBudgets(recipient, token);

  const currentApproved = budget.approved ?? budget.isApproved ?? budget[0];

  const currentMonthlyLimit =
    budget.monthlyLimit ??
    budget.monthlyAmount ??
    budget.maxMonthlyAmount ??
    budget.maxAmountPerMonth ??
    budget[1];

  if (
    currentApproved !== approved ||
    toBigIntValue(currentMonthlyLimit) !== monthlyLimit
  ) {
    const tx = await treasuryPaymentsModule.setPaymentBudget(
      recipient,
      token,
      monthlyLimit,
      approved,
    );
    await tx.wait();
  }
}

async function appointOrUpdateTreasurer(
  treasuryAuthority: any,
  treasurer: string,
  label: string,
  permissions: bigint,
) {
  if (!(await treasuryAuthority.isTreasurer(treasurer))) {
    const tx = await treasuryAuthority.appointTreasurer(
      treasurer,
      label,
      permissions,
    );
    await tx.wait();
    return;
  }

  const currentPermissions =
    await treasuryAuthority.getTreasurerPermissions(treasurer);

  if (toBigIntValue(currentPermissions) !== permissions) {
    const tx = await treasuryAuthority.setTreasurerPermissions(
      treasurer,
      permissions,
    );
    await tx.wait();
  }
}

async function setGuardianIfNeeded(
  treasuryAuthority: any,
  guardian: string,
  allowed: boolean,
) {
  const GUARDIAN_ROLE = await treasuryAuthority.GUARDIAN_ROLE();

  if ((await treasuryAuthority.hasRole(GUARDIAN_ROLE, guardian)) !== allowed) {
    const tx = await treasuryAuthority.setGuardian(guardian, allowed);
    await tx.wait();
  }
}

async function setTreasurerActionPermissionsIfNeeded(
  treasuryTradeModule: any,
  treasurer: string,
  permissions: bigint,
) {
  const currentPermissions =
    await treasuryTradeModule.treasurerActionPermissions(treasurer);

  if (toBigIntValue(currentPermissions) !== permissions) {
    const tx = await treasuryTradeModule.setTreasurerActionPermissions(
      treasurer,
      permissions,
    );
    await tx.wait();
  }
}

function resolveTokenAddress(
  token: string,
  deployment: {
    addresses: {
      sethxToken?: string;
    };
  },
): string {
  if (token === "ETH") return "0x0000000000000000000000000000000000000000";

  if (token === "SETHX") {
    if (!deployment.addresses.sethxToken) {
      throw new Error("SETHX token address missing from deployment output");
    }

    return deployment.addresses.sethxToken;
  }

  if (token.startsWith("0x") && token.length === 42) return token;

  throw new Error(`Unsupported treasury payment token reference: ${token}`);
}

export async function setupTreasuryModules(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
      protocolTreasury: string;
      treasuryAuthority: string;
      treasuryPaymentsModule: string;
      treasuryVaultModule: string;
      treasuryTradeModule: string;
      treasuryFuturesMaintenanceModule: string;
      sethxToken?: string;
    };
  },
) {
  const params = INITIAL_PROTOCOL_PARAMETERS.treasury;

  const initialTreasurer = params.initialTreasurer;
  const initialGuardian = params.initialGuardian || params.initialTreasurer;

  if (!initialTreasurer) {
    throw new Error("Initial treasury treasurer address must be configured");
  }

  if (!initialGuardian) {
    throw new Error("Initial treasury guardian address must be configured");
  }

  const accountRegistry = await ethers.getContractAt(
    "AccountRegistry",
    deployment.addresses.accountRegistry,
  );

  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const protocolTreasury = await ethers.getContractAt(
    "ProtocolTreasury",
    deployment.addresses.protocolTreasury,
  );

  const treasuryAuthority = await ethers.getContractAt(
    "TreasuryAuthority",
    deployment.addresses.treasuryAuthority,
  );

  await setVaultProtocolTreasuryIfNeeded(
    vault,
    deployment.addresses.protocolTreasury,
  );


  const treasuryPaymentsModule = await ethers.getContractAt(
    "TreasuryPaymentsModule",
    deployment.addresses.treasuryPaymentsModule,
  );

  const treasuryTradeModule = await ethers.getContractAt(
    "TreasuryTradeModule",
    deployment.addresses.treasuryTradeModule,
  );

  const FACTORY_ROLE = await accountRegistry.FACTORY_ROLE();
  await grantIfMissing(
    accountRegistry,
    FACTORY_ROLE,
    deployment.addresses.treasuryTradeModule,
  );

  const TREASURY_ROLE = await vault.TREASURY_ROLE();
  await grantIfMissing(
    vault,
    TREASURY_ROLE,
    deployment.addresses.treasuryVaultModule,
  );

  await setApprovedTreasuryModuleIfNeeded(
    protocolTreasury,
    deployment.addresses.treasuryPaymentsModule,
    true,
  );

  await setApprovedTreasuryModuleIfNeeded(
    protocolTreasury,
    deployment.addresses.treasuryTradeModule,
    true,
  );

  await setApprovedTreasuryModuleIfNeeded(
    protocolTreasury,
    deployment.addresses.treasuryFuturesMaintenanceModule,
    true,
  );

  await setApprovedExternalRecipientIfNeeded(
    protocolTreasury,
    initialTreasurer,
    true,
  );

  await setApprovedInternalReceiverIfNeeded(
    protocolTreasury,
    deployment.addresses.treasuryTradeModule,
    true,
  );

  const allTreasuryAuthorityPermissions = combinePermissionBits([
    await treasuryAuthority.PERMISSION_CALL_VAULT(),
    await treasuryAuthority.PERMISSION_MANAGE_LIQUIDITY(),
    await treasuryAuthority.PERMISSION_MANAGE_PAYMENTS(),
    await treasuryAuthority.PERMISSION_TRADE_SETHX(),
    await treasuryAuthority.PERMISSION_PUBLISH_PASSIVE_QUOTES(),
    await treasuryAuthority.PERMISSION_MANAGE_ORACLE_FUNDING(),
  ]);

  await appointOrUpdateTreasurer(
    treasuryAuthority,
    initialTreasurer,
    "Initial treasury operator",
    allTreasuryAuthorityPermissions,
  );

  await setGuardianIfNeeded(treasuryAuthority, initialGuardian, true);

  const allTradeModuleActions = combinePermissionBits([
    await treasuryTradeModule.ACTION_FUND_ACCOUNT(),
    await treasuryTradeModule.ACTION_WITHDRAW_ACCOUNT(),
    await treasuryTradeModule.ACTION_SPOT_TRADE(),
    await treasuryTradeModule.ACTION_LEND(),
    await treasuryTradeModule.ACTION_PASSIVE_LP(),
  ]);

  await setTreasurerActionPermissionsIfNeeded(
    treasuryTradeModule,
    initialTreasurer,
    allTradeModuleActions,
  );

  const paymentBudgets: Record<string, unknown>[] = [];

  for (const paymentRecipient of params.paymentRecipients) {
    const recipient = paymentRecipient.recipient;
    const token = resolveTokenAddress(paymentRecipient.token, deployment);
    const monthlyLimit = toBigIntValue(paymentRecipient.monthlyLimit);
    const approved = Boolean(paymentRecipient.approved);

    await setApprovedExternalRecipientIfNeeded(
      protocolTreasury,
      recipient,
      approved,
    );

    await setPaymentBudgetIfNeeded(
      treasuryPaymentsModule,
      recipient,
      token,
      monthlyLimit,
      approved,
    );

    paymentBudgets.push({
      id: paymentRecipient.id,
      recipient,
      token,
      monthlyLimit: monthlyLimit.toString(),
      approved,
    });
  }

  return {
    treasuryModules: {
      treasuryTradeModuleHasRegistryFactoryRole: await accountRegistry.hasRole(
        FACTORY_ROLE,
        deployment.addresses.treasuryTradeModule,
      ),

      treasuryVaultModuleHasVaultTreasuryRole: await vault.hasRole(
        TREASURY_ROLE,
        deployment.addresses.treasuryVaultModule,
      ),

      vaultProtocolTreasury: await vault.protocolTreasury(),
      vaultProtocolTreasuryConfigured:
        (await vault.protocolTreasury()) === deployment.addresses.protocolTreasury,

      treasuryPaymentsModuleApproved:
        await protocolTreasury.approvedTreasuryModules(
          deployment.addresses.treasuryPaymentsModule,
        ),

      treasuryTradeModuleApproved:
        await protocolTreasury.approvedTreasuryModules(
          deployment.addresses.treasuryTradeModule,
        ),

      treasuryFuturesMaintenanceModuleApproved:
        await protocolTreasury.approvedTreasuryModules(
          deployment.addresses.treasuryFuturesMaintenanceModule,
        ),

      initialTreasurerApprovedExternalRecipient:
        await protocolTreasury.approvedExternalRecipients(initialTreasurer),

      treasuryTradeModuleApprovedInternalReceiver:
        await protocolTreasury.approvedInternalReceivers(
          deployment.addresses.treasuryTradeModule,
        ),

      initialTreasurer,
      initialTreasurerIsActive:
        await treasuryAuthority.isTreasurer(initialTreasurer),

      initialTreasurerPermissions: (
        await treasuryAuthority.getTreasurerPermissions(initialTreasurer)
      ).toString(),

      initialGuardian,
      initialGuardianEnabled: await treasuryAuthority.hasRole(
        await treasuryAuthority.GUARDIAN_ROLE(),
        initialGuardian,
      ),

      initialTreasurerTradeModuleActions: (
        await treasuryTradeModule.treasurerActionPermissions(initialTreasurer)
      ).toString(),

      paymentBudgets,
    },
  };
}
