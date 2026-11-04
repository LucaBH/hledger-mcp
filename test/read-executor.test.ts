import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HLedgerExecutor } from "../src/executor.js";
import { checkHledgerInstallation, resetHledgerPathForTesting } from "../src/hledger-path.js";
import { ReadBudget, ReadLimitError } from "../src/read-budget.js";

test("counts both streams and preserves final-write output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-executor-"));
  const executable = path.join(dir, "fake-hledger");
  try {
    await writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] === "--version") process.exit(0);\nif (process.argv[3] === "slow") { setTimeout(() => process.exit(0), 10000); } else if (process.argv[3] === "overflow") { process.stdout.write("abcde"); setTimeout(() => require("fs").writeFileSync(process.env.SYNTHETIC_MARKER, "continued"), 500); } else if (process.argv[3] === "split") { process.stdout.write(Buffer.from([0xc3])); process.stderr.write("abc"); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50); } else { process.stdout.write("é"); process.stderr.write("abc"); }\n');
    await chmod(executable, 0o700);
    process.env.HLEDGER_EXECUTABLE_PATH = executable;
    expect(checkHledgerInstallation()).toBe(true);
    const result = await HLedgerExecutor.execute("balance", [], { budget: new ReadBudget(5) });
    expect(result.stdout).toBe("é");
    expect(result.stderr).toBe("abc");
    const split = await HLedgerExecutor.execute("balance", ["split"], { budget: new ReadBudget(5) });
    expect(split.stdout).toBe("é");
    expect(split.stderr).toBe("abc");
    await expect(HLedgerExecutor.execute("balance", [], { budget: new ReadBudget(4) })).rejects.toBeInstanceOf(ReadLimitError);
    const marker = path.join(dir, "marker");
    process.env.SYNTHETIC_MARKER = marker;
    await expect(HLedgerExecutor.execute("balance", ["overflow"], { budget: new ReadBudget(4) })).rejects.toBeInstanceOf(ReadLimitError);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(access(marker)).rejects.toThrow();
    const write = await HLedgerExecutor.execute("import", [], { budget: new ReadBudget(1), finalWrite: true });
    expect(write.stdout).toBe("é");
    expect(write.stderr).toBe("abc");
    await expect(HLedgerExecutor.execute("balance", ["slow"], { timeout: 100 })).rejects.toMatchObject({ name: "TimeoutError" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(HLedgerExecutor.execute("balance", ["slow"], { signal: controller.signal })).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    delete process.env.HLEDGER_EXECUTABLE_PATH;
    delete process.env.SYNTHETIC_MARKER;
    resetHledgerPathForTesting();
    await rm(dir, { recursive: true, force: true });
  }
});
