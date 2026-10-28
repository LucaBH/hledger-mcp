import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import {
  AmbiguousFinalWriteError,
  appendTransactionWithAppendOnlyFinalWrite,
  type FinalWriteHandle,
} from "../src/journal-writer.js";

// This test creates only fictional journal data. It does not read repository fixtures.
const SYNTHETIC_JOURNAL = `2026-01-01 Opening balance
  assets:cash  20.00 EUR
  equity:opening  -20.00 EUR
`;

const SYNTHETIC_TRANSACTION = `2026-04-01 Atlas Art Store
  assets:cash  -7.00 EUR
  expenses:office  7.00 EUR`;

describe("appendTransactionWithAppendOnlyFinalWrite failures", () => {
  let tempDir: string;
  let journalPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hledger-writer-synthetic-"));
    journalPath = path.join(tempDir, "fictional.journal");
    await fs.writeFile(journalPath, SYNTHETIC_JOURNAL, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function expectAmbiguousFailure(handle: FinalWriteHandle): Promise<void> {
    await expect(
      appendTransactionWithAppendOnlyFinalWrite({
        journalPath,
        transaction: SYNTHETIC_TRANSACTION,
        finalWriteFileSystem: {
          open: jest.fn().mockResolvedValue(handle),
        },
      }),
    ).rejects.toBeInstanceOf(AmbiguousFinalWriteError);
  }

  it("reports a partial final write as ambiguous without retrying", async () => {
    const write = jest.fn().mockResolvedValue({ bytesWritten: 1 });
    const sync = jest.fn();
    const handle: FinalWriteHandle = {
      write,
      sync,
      close: jest.fn().mockResolvedValue(undefined),
    };

    await expectAmbiguousFailure(handle);

    expect(write).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it("reports a final write error as ambiguous without retrying", async () => {
    const write = jest.fn().mockRejectedValue(new Error("synthetic write failure"));
    const handle: FinalWriteHandle = {
      write,
      sync: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    await expectAmbiguousFailure(handle);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports a final sync error as ambiguous without retrying", async () => {
    const write = jest
      .fn()
      .mockImplementation(async (buffer: Uint8Array) => ({
        bytesWritten: buffer.length,
      }));
    const sync = jest.fn().mockRejectedValue(new Error("synthetic sync failure"));
    const handle: FinalWriteHandle = {
      write,
      sync,
      close: jest.fn().mockResolvedValue(undefined),
    };

    await expectAmbiguousFailure(handle);

    expect(write).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
