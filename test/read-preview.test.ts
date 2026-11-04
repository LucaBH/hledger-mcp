import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoveEntryTool } from "../src/tools/remove-entry.js";
import { ReplaceEntryTool } from "../src/tools/replace-entry.js";
import { RewriteTransactionsTool } from "../src/tools/rewrite.js";
import { WebTool } from "../src/tools/web.js";

test("oversized direct file reads fail safely in preview operations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-preview-"));
  const file = path.join(dir, "synthetic.journal");
  try {
    await writeFile(file, ";".repeat(16 * 1024 * 1024 + 1));
    const location = { file, startLine: 1, endLine: 1 };
    const results = await Promise.all([
      new RemoveEntryTool(file).execute({ dryRun: true, entry: "synthetic", location }),
      new ReplaceEntryTool(file).execute({ dryRun: true, original: "synthetic", replacement: "synthetic", location }),
      new RewriteTransactionsTool(file).execute({ dryRun: true, addPostings: [{ account: "expenses:fictional", amount: "1 ABC" }] }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ success: false, error: "ReadLimitError", message: "The read output limit was exceeded." });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewrite preview and final operation work with fictional includes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-rewrite-"));
  const master = path.join(dir, "master.journal");
  const included = path.join(dir, "items.journal");
  const original = "2025-01-01 Fictional\n    expenses:fictional  1 ABC\n    assets:fictional\n";
  try {
    await writeFile(master, "!include items*.journal\n");
    await writeFile(included, original);
    const tool = new RewriteTransactionsTool(master, { skipBackup: true });
    const input = { query: "expenses:fictional", addPostings: [
      { account: "equity:fictional", amount: "*1" },
      { account: "assets:otherfictional", amount: "*-1" },
    ] };
    const preview = await tool.execute({ ...input, dryRun: true });
    expect(preview.success).toBe(true);
    expect(await readFile(included, "utf8")).toBe(original);
    const result = await tool.execute(input);
    expect(result.success).toBe(true);
    expect(await readFile(included, "utf8")).toContain("equity:fictional");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounds startup output from a read-only web process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-web-"));
  const executable = path.join(dir, "fake-web");
  try {
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(17 * 1024 * 1024, 120)); setTimeout(() => process.exit(0), 10000);\n');
    await chmod(executable, 0o700);
    process.env.HLEDGER_WEB_EXECUTABLE_PATH = executable;
    const result = await new WebTool("synthetic.journal", { readOnly: true }).execute({ port: 45678 });
    expect(result).toMatchObject({ success: false, error: "ReadLimitError", message: "The read output limit was exceeded." });
  } finally {
    delete process.env.HLEDGER_WEB_EXECUTABLE_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});
