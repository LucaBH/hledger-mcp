import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { AddTransaction2Tool } from "../src/tools/add-transaction-2.js";
import { HLedgerExecutor } from "../src/executor.js";
import { HLedgerError } from "../src/types.js";

const SYNTHETIC_JOURNAL = `commodity EUR 1.000,00

2026-01-01 Opening balance
  assets:cash  20,00 EUR
  equity:opening  -20,00 EUR
`;

const CONFLICTING_DECIMAL_JOURNAL = `decimal-mark .
commodity EUR 1.000,00

2026-01-01 Opening balance
  assets:cash  EUR 20.00
  equity:opening  EUR -20.00
`;

describe("AddTransaction2Tool", () => {
  let tempDir: string;
  let journalPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hledger-add-2-test-"));
    journalPath = path.join(tempDir, "fictional.journal");
    await fs.writeFile(journalPath, SYNTHETIC_JOURNAL, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns an hledger-generated dry-run preview without changing the journal", async () => {
    const original = await fs.readFile(journalPath, "utf8");
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-14",
      description: "Aurora stationery",
      dryRun: true,
      postings: [
        { account: "assets:cash", quantity: "-1.50", commodity: "EUR" },
        { account: "expenses:office", quantity: "1.50", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The dry run did not succeed");
    }
    expect(result.metadata.command).toBe("hledger import --dry-run");
    expect(await fs.readFile(journalPath, "utf8")).toBe(original);
    const preview = JSON.parse(result.data) as { transaction: string };
    expect(preview.transaction).toContain("Aurora stationery");
    expect(preview.transaction).toContain("EUR 1,50");
  });

  it("appends a formatted transaction through hledger import", async () => {
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-15",
      description: "Cedar supplies",
      postings: [
        { account: "assets:cash", quantity: "-2.75", commodity: "EUR" },
        { account: "expenses:office", quantity: "2.75", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The import did not succeed");
    }
    expect(result.metadata.command).toBe("hledger import");
    const journal = await fs.readFile(journalPath, "utf8");
    expect(journal).toContain("2026-02-15 Cedar supplies");
    expect(journal).toContain("EUR 2,75");
  });

  it("maps a transaction comment to an hledger transaction tag", async () => {
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-15",
      description: "Tagged cedar supplies",
      comment: "project:orion",
      postings: [
        { account: "assets:cash", quantity: "-2.75", commodity: "EUR" },
        { account: "expenses:office", quantity: "2.75", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(true);
    const tags = await HLedgerExecutor.execute("tags", ["--file", journalPath]);
    expect(tags.stdout).toContain("project");
  });

  it("uses the commodity display style with a conflicting target decimal mark", async () => {
    await fs.writeFile(journalPath, CONFLICTING_DECIMAL_JOURNAL, "utf8");
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-15",
      description: "Conflicting decimal mark",
      dryRun: true,
      postings: [
        { account: "assets:cash", quantity: "-2.75", commodity: "EUR" },
        { account: "expenses:office", quantity: "2.75", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The dry run did not succeed");
    }
    const preview = JSON.parse(result.data) as { transaction: string };
    expect(preview.transaction).toContain("EUR 2,75");
  });

  it("encodes a commodity name as a journal literal before CSV serialization", async () => {
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-16",
      description: "Fictional inventory",
      dryRun: true,
      postings: [
        { account: "assets:stock", quantity: "-1", commodity: "green apples" },
        { account: "expenses:food", quantity: "1", commodity: "green apples" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The dry run did not succeed");
    }
    const preview = JSON.parse(result.data) as { transaction: string };
    expect(preview.transaction).toContain('"green apples"');
  });

  it("imports a comma-containing commodity", async () => {
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-16",
      description: "Fictional comma commodity",
      dryRun: true,
      postings: [
        { account: "assets:stock", quantity: "-1", commodity: "A,B" },
        { account: "expenses:food", quantity: "1", commodity: "A,B" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The dry run did not succeed");
    }
    const preview = JSON.parse(result.data) as { transaction: string };
    expect(preview.transaction).toContain("A,B");
  });

  it("applies CSV escaping after commodity normalization", async () => {
    let generatedCsv = "";
    let workspaceMode = 0;
    const executeSpy = jest
      .spyOn(HLedgerExecutor, "execute")
      .mockImplementation(async (_command, args) => {
        const dataFile = args.at(-1) ?? "";
        generatedCsv = await fs.readFile(dataFile, "utf8");
        workspaceMode = (await fs.stat(path.dirname(dataFile))).mode & 0o777;
        return {
          success: true,
          stdout: "2026-02-16 Synthetic preview\n",
          stderr: "",
          exitCode: 0,
          command: "hledger import --dry-run",
          duration: 1,
        };
      });

    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-16",
      description: "Synthetic CSV serialization",
      dryRun: true,
      postings: [
        { account: "assets:stock", quantity: "-1", commodity: "A,B" },
        { account: "expenses:food", quantity: "1", commodity: "A,B" },
      ],
    });

    expect(result.success).toBe(true);
    expect(generatedCsv).toContain('"""A,B"""');
    expect(workspaceMode & 0o077).toBe(0);
    executeSpy.mockRestore();
  });

  it("supports a balanced transaction with multiple commodities", async () => {
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-17",
      description: "Fictional exchange",
      dryRun: true,
      postings: [
        { account: "assets:cash", quantity: "-1.25", commodity: "EUR" },
        { account: "equity:conversion", quantity: "1.25", commodity: "EUR" },
        { account: "equity:conversion", quantity: "-3", commodity: "gold" },
        { account: "assets:stock", quantity: "3", commodity: "gold" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("The dry run did not succeed");
    }
    const preview = JSON.parse(result.data) as { transaction: string };
    expect(preview.transaction).toContain("EUR 1,25");
    expect(preview.transaction).toContain("3 gold");
  });

  it("returns an hledger failure for an unbalanced transaction", async () => {
    const original = await fs.readFile(journalPath, "utf8");
    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-17",
      description: "Unbalanced synthetic transaction",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "2", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HLedgerError");
    expect(await fs.readFile(journalPath, "utf8")).toBe(original);
  });

  it("removes the per-call input and tracking files after a confirmed import", async () => {
    const workspaceRoot = path.join(tempDir, "workspace-root");
    await fs.mkdir(workspaceRoot);
    const tool = new AddTransaction2Tool(journalPath, {
      temporaryDirectory: workspaceRoot,
    });

    const result = await tool.execute({
      date: "2026-02-17",
      description: "Temporary workspace cleanup",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "1", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(true);
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
  });

  it("removes the workspace when CSV creation fails", async () => {
    const workspaceRoot = path.join(tempDir, "workspace-root");
    await fs.mkdir(workspaceRoot);
    const writeSpy = jest
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("synthetic CSV write failure"));

    const result = await new AddTransaction2Tool(journalPath, {
      temporaryDirectory: workspaceRoot,
    }).execute({
      date: "2026-02-18",
      description: "CSV write failure",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "1", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("synthetic CSV write failure");
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
    writeSpy.mockRestore();
  });

  it("keeps concurrent imports with separate input identities", async () => {
    const first = new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-19",
      description: "Orion map shop",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "1", commodity: "EUR" },
      ],
    });
    const second = new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-20",
      description: "Lumen print house",
      postings: [
        { account: "assets:cash", quantity: "-2", commodity: "EUR" },
        { account: "expenses:office", quantity: "2", commodity: "EUR" },
      ],
    });

    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.success)).toBe(true);

    const journal = await fs.readFile(journalPath, "utf8");
    expect(journal).toContain("2026-02-19 Orion map shop");
    expect(journal).toContain("2026-02-20 Lumen print house");
  });

  it("reports a failed final import as ambiguous after a successful preview", async () => {
    const executeSpy = jest
      .spyOn(HLedgerExecutor, "execute")
      .mockResolvedValueOnce({
        success: true,
        stdout: "2026-02-21 Synthetic preview\n",
        stderr: "",
        exitCode: 0,
        command: "hledger import --dry-run",
        duration: 1,
      })
      .mockRejectedValueOnce(
        new HLedgerError("final import failed", 1, "failure", "hledger import"),
      );

    const result = await new AddTransaction2Tool(journalPath).execute({
      date: "2026-02-21",
      description: "Ambiguous synthetic outcome",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "1", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("AmbiguousFinalWriteError");
    expect(result.message).toContain("Do not retry automatically");
    expect(executeSpy).toHaveBeenCalledTimes(2);
    executeSpy.mockRestore();
  });

  it("rejects a non-canonical quantity", async () => {
    await expect(
      new AddTransaction2Tool(journalPath).execute({
        date: "2026-02-17",
        description: "Invalid quantity",
        postings: [
          { account: "assets:cash", quantity: "1,50", commodity: "EUR" },
          { account: "expenses:office", quantity: "-1.50", commodity: "EUR" },
        ],
      }),
    ).rejects.toThrow("Invalid quantity");

    await expect(
      new AddTransaction2Tool(journalPath).execute({
        date: "2026-02-17",
        description: "Grouped quantity",
        postings: [
          { account: "assets:cash", quantity: "-1,000.00", commodity: "EUR" },
          { account: "expenses:office", quantity: "1000.00", commodity: "EUR" },
        ],
      }),
    ).rejects.toThrow("Invalid quantity");
  });

  it("rejects caller-supplied import and posting-extension fields", async () => {
    await expect(
      new AddTransaction2Tool(journalPath).execute({
        date: "2026-02-17",
        description: "Unsupported fields",
        postings: [
          { account: "assets:cash", quantity: "-1", commodity: "EUR" },
          { account: "expenses:office", quantity: "1", commodity: "EUR" },
        ],
        rulesFile: "/tmp/unsafe.rules",
        command: "import",
        tags: ["project:orion"],
        postingComments: ["unsafe"],
        postingTags: ["unsafe:value"],
        notes: ["unsafe"],
      }),
    ).rejects.toThrow("Unrecognized key(s)");
  });

  it("rejects a multi-line transaction comment", async () => {
    await expect(
      new AddTransaction2Tool(journalPath).execute({
        date: "2026-02-17",
        description: "Invalid comment",
        comment: "project:orion\nunsafe",
        postings: [
          { account: "assets:cash", quantity: "-1", commodity: "EUR" },
          { account: "expenses:office", quantity: "1", commodity: "EUR" },
        ],
      }),
    ).rejects.toThrow("Text contains unsupported characters");
  });

  it("rejects a file value that contains a control character", async () => {
    await expect(
      new AddTransaction2Tool(journalPath).execute({
        file: `${journalPath}\nunsafe`,
        date: "2026-02-17",
        description: "Invalid file value",
        postings: [
          { account: "assets:cash", quantity: "-1", commodity: "EUR" },
          { account: "expenses:office", quantity: "1", commodity: "EUR" },
        ],
      }),
    ).rejects.toThrow("Invalid file path");
  });

  it("rejects final writes in read-only mode", async () => {
    const original = await fs.readFile(journalPath, "utf8");
    const result = await new AddTransaction2Tool(journalPath, { readOnly: true }).execute({
      date: "2026-02-18",
      description: "Blocked write",
      postings: [
        { account: "assets:cash", quantity: "-1", commodity: "EUR" },
        { account: "expenses:office", quantity: "1", commodity: "EUR" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("read-only mode");
    expect(await fs.readFile(journalPath, "utf8")).toBe(original);
  });
});
