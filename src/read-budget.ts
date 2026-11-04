import { createReadStream } from "node:fs";

export const DEFAULT_READ_LIMIT = 16 * 1024 * 1024;
export const MAX_READ_LIMIT = 256 * 1024 * 1024;
let configuredReadLimit = DEFAULT_READ_LIMIT;

export class ReadLimitError extends Error {
  constructor() {
    super("The read output limit was exceeded.");
    this.name = "ReadLimitError";
  }
}

export function configureReadLimit(value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid read limit.");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < DEFAULT_READ_LIMIT || limit > MAX_READ_LIMIT) {
    throw new Error("Invalid read limit.");
  }
  configuredReadLimit = limit;
}

export class ReadBudget {
  private used = 0;
  constructor(private readonly limit = configuredReadLimit) {}

  consume(bytes: number): void {
    if (bytes > this.limit - this.used) throw new ReadLimitError();
    this.used += bytes;
  }
}

export async function readBoundedFile(filePath: string, budget: ReadBudget): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      budget.consume(data.length);
      chunks.push(data);
    }
  } catch (error) {
    if (error instanceof ReadLimitError) throw error;
    throw new Error("Failed to read journal data.");
  }
  return Buffer.concat(chunks).toString("utf8");
}
