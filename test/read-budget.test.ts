import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReadBudget, ReadLimitError, readBoundedFile, configureReadLimit } from "../src/read-budget.js";

test("counts combined chunks and accepts the exact byte limit", () => {
  const budget = new ReadBudget(4);
  budget.consume(Buffer.byteLength("é"));
  budget.consume(2);
  expect(() => budget.consume(1)).toThrow(ReadLimitError);
});

test("shares a budget with direct file reads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-budget-"));
  try {
    const file = path.join(dir, "synthetic.txt");
    await writeFile(file, "éé", "utf8");
    const exact = new ReadBudget(5);
    exact.consume(1);
    expect(await readBoundedFile(file, exact)).toBe("éé");
    const overflow = new ReadBudget(4);
    overflow.consume(1);
    await expect(readBoundedFile(file, overflow)).rejects.toThrow(ReadLimitError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates the startup byte limit", () => {
  for (const value of ["", "0", "16777215", "1.5", "268435457", "999999999999999999999"]) {
    expect(() => configureReadLimit(value)).toThrow("Invalid read limit");
  }
  expect(() => configureReadLimit("16777216")).not.toThrow();
  expect(() => configureReadLimit("268435456")).not.toThrow();
  configureReadLimit("16777216");
});

test("does not expose a file path when a direct read fails", async () => {
  await expect(readBoundedFile("/synthetic-private-name/missing", new ReadBudget(4)))
    .rejects.toThrow("Failed to read journal data.");
});

test("rejects an invalid command-line limit before reading a journal", () => {
  const result = spawnSync(process.execPath, ["build/index.js", "synthetic.journal", "--read-limit=1"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Invalid read limit");
  expect(result.stderr).not.toContain("synthetic.journal");
});
