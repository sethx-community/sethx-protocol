import { expect } from "chai";

export async function expectRevert(promise: Promise<unknown>) {
  let reverted = false;

  try {
    await promise;
  } catch {
    reverted = true;
  }

  expect(reverted).to.equal(true);
}
