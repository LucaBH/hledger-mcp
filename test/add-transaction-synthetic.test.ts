import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AddTransactionTool } from "../src/tools/add.js";
import { HLedgerExecutor } from "../src/executor.js";

// This test creates only fictional journal data. It does not read repository fixtures.
const SYNTHETIC_JOURNAL = `2026-01-01 Opening balance
  assets:cash  20.00 EUR
  equity:opening  -20.00 EUR
`;

const WORKER_SOURCE = `
import { pathToFileURL } from "node:url";

const [toolPath, journalPath, date, description] = process.argv.slice(2);
const { AddTransactionTool } = await import(pathToFileURL(toolPath).href);
const result = await new AddTransactionTool().execute({
  file: journalPath,
  date,
  description,
  postings: [
    { account: "assets:cash", amount: "-4.00 EUR" },
    { account: "expenses:travel", amount: "4.00 EUR" },
  ],
});

if (!result.success) {
  process.stderr.write(JSON.stringify(result));
  process.exitCode = 1;
}
`;

describe("AddTransactionTool synthetic contract", () => {
  let tempDir: string;
  let journalPath: string;
  let workerPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hledger-add-synthetic-"));
    journalPath = path.join(tempDir, "fictional.journal");
    workerPath = path.join(tempDir, "add-worker.mjs");
    await fs.writeFile(journalPath, SYNTHETIC_JOURNAL, "utf8");
    await fs.writeFile(workerPath, WORKER_SOURCE, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function runAddInSeparateProcess(
    date: string,
    description: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        workerPath,
        path.resolve("build/tools/add.js"),
        journalPath,
        date,
        description,
      ]);
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`Synthetic add worker failed: ${stderr}`));
      });
    });
  }

  it("accepts the existing file input and preserves the success response shape", async () => {
    const tool = new AddTransactionTool();

    const result = await tool.execute({
      file: journalPath,
      date: "2026-02-14",
      description: "Northstar Stationery",
      postings: [
        { account: "assets:cash", amount: "-5.00 EUR" },
        { account: "expenses:office", amount: "5.00 EUR" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The synthetic add transaction did not succeed");
    }

    expect(result).toEqual({
      success: true,
      data: expect.any(String),
      metadata: {
        command: expect.any(String),
        duration: expect.any(Number),
        exitCode: 0,
      },
    });

    const journalContents = await fs.readFile(journalPath, "utf8");
    expect(journalContents).toContain("2026-02-14 Northstar Stationery");
  });

  it("keeps a dry run from changing the synthetic journal", async () => {
    const originalContents = await fs.readFile(journalPath, "utf8");
    const tool = new AddTransactionTool();

    const result = await tool.execute({
      file: journalPath,
      date: "2026-02-15",
      description: "Aurora Paper Studio",
      dryRun: true,
      postings: [
        { account: "assets:cash", amount: "-2.00 EUR" },
        { account: "expenses:office", amount: "2.00 EUR" },
      ],
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(journalPath, "utf8")).toBe(originalContents);
  });

  it("appends without a backup or journal replacement", async () => {
    const originalStat = await fs.stat(journalPath);
    const tool = new AddTransactionTool();

    const result = await tool.execute({
      file: journalPath,
      date: "2026-03-01",
      description: "Cedar Library Supplies",
      postings: [
        { account: "assets:cash", amount: "-3.00 EUR" },
        { account: "expenses:books", amount: "3.00 EUR" },
      ],
    });

    expect(result.success).toBe(true);
    const files = await fs.readdir(tempDir);
    expect(files.some((file) => file.startsWith("fictional.journal.bak-"))).toBe(
      false,
    );

    const updatedStat = await fs.stat(journalPath);
    expect(updatedStat.ino).toBe(originalStat.ino);
  });

  it("keeps concurrent additions from separate processes in the journal", async () => {
    await Promise.all([
      runAddInSeparateProcess("2026-03-02", "Orion Map Shop"),
      runAddInSeparateProcess("2026-03-03", "Lumen Print House"),
    ]);

    const journalContents = await fs.readFile(journalPath, "utf8");
    expect(journalContents).toContain("2026-03-02 Orion Map Shop");
    expect(journalContents).toContain("2026-03-03 Lumen Print House");

    const checkResult = await HLedgerExecutor.execute("check", [
      "--file",
      journalPath,
    ]);
    expect(checkResult.exitCode).toBe(0);
  });
});
