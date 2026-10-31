import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ToolMetadata } from "../base-tool.js";
import { BaseTool } from "../base-tool.js";
import { HLedgerExecutor } from "../executor.js";
import { AmbiguousFinalWriteError } from "../journal-writer.js";
import {
  DateSchema,
  FilePathSchema,
  type CommandResult,
  ValidationError,
} from "../types.js";

const MAX_POSTINGS = 10;
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const QuantitySchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, "Invalid quantity");
const CommoditySchema = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => /\S/u.test(value), "Commodity is required")
  .refine(
    (value) => !value.includes('"') && !hasControlCharacters(value),
    "Commodity contains unsupported characters",
  );
function textSchema(maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) => !hasControlCharacters(value),
      "Text contains unsupported characters",
    );
}

const TextSchema = textSchema(500);
const AccountSchema = textSchema(200);

const PostingSchema = z.object({
  account: AccountSchema,
  quantity: QuantitySchema,
  commodity: CommoditySchema,
}).strict();

const AddTransaction2InputSchema = z.object({
  file: FilePathSchema.optional(),
  date: DateSchema,
  status: z.enum(["*", "!"]).optional(),
  code: textSchema(100).optional(),
  description: TextSchema,
  comment: textSchema(500).optional(),
  postings: z.array(PostingSchema).min(2).max(MAX_POSTINGS),
  dryRun: z.boolean().optional(),
}).strict();

interface AddTransaction2Options {
  readOnly?: boolean;
  temporaryDirectory?: string;
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function commodityLiteral(name: string): string {
  return /^\p{L}+$/u.test(name) ? name : `"${name}"`;
}

function rulesFile(): string {
  const fields = ["date", "status", "code", "description", "comment"];
  const rules = ["decimal-mark ."];

  for (let index = 1; index <= MAX_POSTINGS; index += 1) {
    fields.push(
      `posting${index}_account`,
      `posting${index}_quantity`,
      `posting${index}_commodity`,
    );
  }

  rules.push(`fields ${fields.join(",")}`);
  for (let index = 1; index <= MAX_POSTINGS; index += 1) {
    rules.push(`account${index} %posting${index}_account`);
    rules.push(
      `amount${index} %posting${index}_quantity %posting${index}_commodity`,
    );
  }

  return `${rules.join("\n")}\n`;
}

export class AddTransaction2Tool extends BaseTool<typeof AddTransaction2InputSchema> {
  readonly metadata: ToolMetadata<typeof AddTransaction2InputSchema> = {
    name: "hledger_add_transaction_2",
    description: "Add a transaction with canonical decimal quantities and commodities",
    schema: AddTransaction2InputSchema,
  };

  private readonly readOnly: boolean;
  private readonly temporaryDirectory?: string;

  constructor(journalFilePath?: string, options: AddTransaction2Options = {}) {
    super(journalFilePath);
    this.readOnly = options.readOnly ?? false;
    this.temporaryDirectory = options.temporaryDirectory;
  }

  protected supportsOutputFormat(): boolean {
    return false;
  }

  protected async run(input: z.infer<typeof AddTransaction2InputSchema>) {
    const dryRun = input.dryRun ?? false;
    if (this.readOnly && !dryRun) {
      throw new ValidationError("Add transactions are disabled while the server is running in read-only mode");
    }

    const targetFile = input.file ?? this.journalFilePath;
    if (!targetFile) {
      throw new ValidationError("No journal file specified");
    }

    const workspace = await fs.mkdtemp(
      path.join(this.temporaryDirectory ?? os.tmpdir(), "hledger-add-2-"),
    );
    const dataFile = path.join(workspace, "transaction.csv");
    const rulesPath = path.join(workspace, "transaction.rules");
    const args = [
      "--no-conf",
      "--file",
      path.resolve(targetFile),
      "--rules-file",
      rulesPath,
      dataFile,
    ];

    let finalWriteAttempted = false;
    let response: CommandResult | undefined;
    let operationError: unknown;
    try {
      await fs.writeFile(dataFile, this.csvRecord(input), "utf8");
      await fs.writeFile(rulesPath, rulesFile(), "utf8");

      const preview = await HLedgerExecutor.execute("import", [
        ...args.slice(0, -1),
        "--dry-run",
        dataFile,
      ]);

      if (dryRun) {
        response = {
          success: true,
          stdout: JSON.stringify({ applied: false, transaction: preview.stdout }),
          stderr: preview.stderr,
          exitCode: preview.exitCode,
          command: "hledger import --dry-run",
          duration: preview.duration,
        };
      } else {
        let result;
        try {
          finalWriteAttempted = true;
          result = await HLedgerExecutor.execute("import", args);
        } catch {
          throw new AmbiguousFinalWriteError();
        }

        response = {
          success: true,
          stdout: JSON.stringify({ applied: true, transaction: preview.stdout }),
          stderr: [preview.stderr, result.stderr].filter(Boolean).join("\n"),
          exitCode: result.exitCode,
          command: "hledger import",
          duration: preview.duration + result.duration,
        };
      }
    } catch (error) {
      operationError = error;
    }

    try {
      await fs.rm(workspace, { recursive: true, force: true });
    } catch {
      if (finalWriteAttempted) {
        operationError = new AmbiguousFinalWriteError();
      } else if (!operationError) {
        operationError = new ValidationError("Temporary import data cleanup failed");
      }
    }

    if (operationError) {
      throw operationError;
    }

    if (!response) {
      throw new ValidationError("Import did not produce a result");
    }
    return response;
  }

  private csvRecord(input: z.infer<typeof AddTransaction2InputSchema>): string {
    const values = [
      input.date,
      input.status ?? "",
      input.code ?? "",
      input.description,
      input.comment ?? "",
    ];
    for (let index = 0; index < MAX_POSTINGS; index += 1) {
      const posting = input.postings[index];
      values.push(
        posting?.account ?? "",
        posting?.quantity ?? "",
        posting ? commodityLiteral(posting.commodity) : "",
      );
    }
    return `${values.map(csvField).join(",")}\n`;
  }
}
