import { expect } from "chai";
import { id } from "ethers";

export async function expectCustomError(
  action: () => Promise<unknown>,
  customErrorName: string,
) {
  const expectedSelector = id(`${customErrorName}()`).slice(0, 10);

  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const hasDecodedName = message.includes(customErrorName);
    const hasSelector = message.includes(expectedSelector);

    expect(
      hasDecodedName || hasSelector,
      `Expected custom error ${customErrorName} or selector ${expectedSelector}, but got: ${message}`,
    ).to.equal(true);

    return;
  }

  throw new Error(
    `Expected custom error ${customErrorName}, but transaction succeeded`,
  );
}
