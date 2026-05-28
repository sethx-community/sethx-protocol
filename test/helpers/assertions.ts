import { expect } from "chai";

const CUSTOM_ERROR_SELECTORS: Record<string, string> = {
  Unauthorized: "0x82b42900",
};

export async function expectCustomError(
  action: () => Promise<unknown>,
  customErrorName: string,
) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectedSelector = CUSTOM_ERROR_SELECTORS[customErrorName];

    if (
      message.includes(customErrorName) ||
      (expectedSelector && message.includes(expectedSelector))
    ) {
      return;
    }

    throw new Error(
      `Expected custom error ${customErrorName}${
        expectedSelector ? ` or selector ${expectedSelector}` : ""
      }, but got: ${message}`,
    );
  }

  throw new Error(
    `Expected custom error ${customErrorName}, but transaction succeeded`,
  );
}
