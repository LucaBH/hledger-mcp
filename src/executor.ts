import { spawn } from "child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult } from "./types.js";
import { HLedgerError, TimeoutError } from "./types.js";
import { getHledgerPath } from "./hledger-path.js";
import { ReadBudget, ReadLimitError } from "./read-budget.js";

// Allowlist of supported hledger commands
const ALLOWED_COMMANDS = new Set([
  "accounts",
  "print",
  "register",
  "balance",
  "balancesheet",
  "incomestatement",
  "cashflow",
  "balancesheetequity",
  "aregister",
  "activity",
  "stats",
  "roi",
  "prices",
  "descriptions",
  "payees",
  "codes",
  "commodities",
  "files",
  "tags",
  "notes",
  "check",
  "diff",
  "close",
  "rewrite",
  "import",
  "web",
]);

// Allowlist of supported flags (without -- prefix)
const ALLOWED_FLAGS = new Set([
  "file",
  "rules",
  "rules-file",
  "no-conf",
  "begin",
  "end",
  "period",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "depth",
  "real",
  "empty",
  "cost",
  "market",
  "exchange",
  "cleared",
  "pending",
  "unmarked",
  "flat",
  "tree",
  "historical",
  "cumulative",
  "change",
  "sum",
  "budget",
  "count",
  "average",
  "row-total",
  "no-total",
  "sort-amount",
  "percent",
  "invert",
  "transpose",
  "output-format",
  "explicit",
  "round",
  "new",
  "match",
  "location",
  "alias",
  "auto",
  "forecast",
  "ignore-assertions",
  "strict",
  "verbose-tags",
  "pivot",
  "drop",
  "declared",
  "no-elide",
  "format",
  "layout",
  "base-url",
  "serve",
  "serve-browse",
  "serve-api",
  "allow",
  "cors",
  "host",
  "port",
  "socket",
  "test",
  "output-file",
  "pretty",
  "commodity-style",
  "value",
  "valuechange",
  "today",
  "date2",
  "no-totals",
  "related",
  "catchup",
  "dry-run",
  "add-posting",
  "diff",
  "clopen",
  "close",
  "open",
  "assign",
  "assert",
  "retain",
  "show-costs",
  "interleaved",
  "assertion-type",
  "close-desc",
  "close-acct",
  "open-desc",
  "open-acct",
  "round",
]);

export interface ExecuteOptions {
  timeout?: number; // milliseconds, default 30000 (30 seconds)
  signal?: AbortSignal;
  budget?: ReadBudget;
  finalWrite?: boolean;
}

export class HLedgerExecutor {
  private static readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

  /**
   * Execute a hledger command with security validation
   */
  static async execute(
    command: string,
    args: string[] = [],
    options: ExecuteOptions = {},
  ): Promise<CommandResult> {
    const startTime = Date.now();

    const { sanitizedArgs, fullCommand } = this.prepareCommand(command, args);

    // Set up timeout
    const timeout = options.timeout ?? this.DEFAULT_TIMEOUT;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, timeout);

    // Use provided signal or timeout signal
    const signal = options.signal
      ? this.combineSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;

    try {
      const result = await this.spawnCommand(command, sanitizedArgs, signal, options.finalWrite ? undefined : (options.budget ?? new ReadBudget()));
      const duration = Date.now() - startTime;

      clearTimeout(timeoutId);

      return {
        ...result,
        command: fullCommand,
        duration,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (signal.aborted) {
        throw new TimeoutError(
          `Command timed out after ${timeout}ms`,
        );
      }

      throw error;
    }
  }

  /**
   * Validate command and sanitize arguments without executing.
   */
  static prepareCommand(
    command: string,
    args: string[] = [],
  ): { sanitizedArgs: string[]; fullCommand: string } {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new HLedgerError(
        `Command '${command}' is not allowed`,
        1,
        `Unsupported command: ${command}`,
        `hledger ${command}`,
      );
    }

    const sanitizedArgs = this.sanitizeArgs(args);
    const commandParts = ["hledger", command, ...sanitizedArgs];
    const fullCommand = commandParts.join(" ");

    return { sanitizedArgs, fullCommand };
  }

  /**
   * Sanitize and validate command arguments
   */
  private static sanitizeArgs(args: string[]): string[] {
    const sanitized: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Handle flags
      if (arg.startsWith("--")) {
        const flag = arg.substring(2).split("=")[0];

        if (!ALLOWED_FLAGS.has(flag)) {
          throw new HLedgerError(
            `Flag '${arg}' is not allowed`,
            1,
            `Unsupported flag: ${arg}`,
            `hledger ${arg}`,
          );
        }

        // Validate file paths for file-related flags
        if (
          (flag === "file" ||
            flag === "rules" ||
            flag === "rules-file" ||
            flag === "output-file") &&
          arg.includes("=")
        ) {
          const filePath = arg.split("=", 2)[1];
          this.validateFilePath(filePath);
        }

        sanitized.push(arg);
      }
      // Handle short flags
      else if (arg.startsWith("-") && arg.length === 2) {
        // Map common short flags to their long equivalents for validation
        const shortFlagMap: Record<string, string> = {
          f: "file",
          b: "begin",
          e: "end",
          p: "period",
          D: "daily",
          W: "weekly",
          M: "monthly",
          Q: "quarterly",
          Y: "yearly",
          R: "real",
          E: "empty",
          B: "cost",
          V: "market",
          X: "exchange",
          C: "cleared",
          P: "pending",
          U: "unmarked",
          l: "flat",
          t: "tree",
          H: "historical",
          A: "average",
          T: "row-total",
          N: "no-total",
          S: "sort-amount",
          x: "explicit",
          m: "match",
          s: "strict",
          I: "ignore-assertions",
        };

        const shortFlag = arg.substring(1);
        const longFlag = shortFlagMap[shortFlag];

        if (!longFlag || !ALLOWED_FLAGS.has(longFlag)) {
          throw new HLedgerError(
            `Flag '${arg}' is not allowed`,
            1,
            `Unsupported flag: ${arg}`,
            `hledger ${arg}`,
          );
        }

        sanitized.push(arg);
      }
      // Handle depth shorthand (-1, -2, etc.)
      else if (/^-\d+$/.test(arg)) {
        const depth = parseInt(arg.substring(1));
        if (depth < 1 || depth > 10) {
          throw new HLedgerError(
            `Depth '${arg}' is out of allowed range (1-10)`,
            1,
            `Invalid depth: ${arg}`,
            `hledger ${arg}`,
          );
        }
        sanitized.push(arg);
      }
      // Handle query arguments and values
      else {
        // Basic sanitization - no null bytes, reasonable length
        if (arg.includes("\0") || arg.length > 1000) {
          throw new HLedgerError(
            `Argument contains invalid characters or is too long`,
            1,
            `Invalid argument: ${arg}`,
            `hledger ${arg}`,
          );
        }
        sanitized.push(arg);
      }
    }

    return sanitized;
  }

  /**
   * Validate file paths to prevent directory traversal
   */
  private static validateFilePath(filePath: string): void {
    if (
      filePath.includes("\0") ||
      filePath.includes("../") ||
      filePath.includes("..\\") ||
      filePath.length > 1000
    ) {
      throw new HLedgerError(
        `Invalid file path: ${filePath}`,
        1,
        `File path validation failed`,
        `file path: ${filePath}`,
      );
    }
  }

  /**
   * Spawn hledger process with proper error handling
   */
  private static async spawnCommand(
    command: string,
    args: string[],
    signal: AbortSignal,
    budget?: ReadBudget,
  ): Promise<Omit<CommandResult, "command" | "duration">> {
    return new Promise((resolve, reject) => {
      const hledgerPath = getHledgerPath();
      const child = spawn(hledgerPath, [command, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });

      let stdout = "";
      let stderr = "";
      let overflow = false;
      let processError = false;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      child.stdout.on("data", (data) => {
        if (overflow) return;
        try { budget?.consume(data.length); } catch {
          overflow = true;
          stdout = "";
          stderr = "";
          child.kill("SIGKILL");
          return;
        }
        stdout += stdoutDecoder.write(data);
      });

      child.stderr.on("data", (data) => {
        if (overflow) return;
        try { budget?.consume(data.length); } catch {
          overflow = true;
          stdout = "";
          stderr = "";
          child.kill("SIGKILL");
          return;
        }
        stderr += stderrDecoder.write(data);
      });

      child.on("error", () => { processError = true; });
      const onStreamError = () => {
        processError = true;
        child.kill("SIGKILL");
      };
      child.stdout.on("error", onStreamError);
      child.stderr.on("error", onStreamError);

      child.on("close", (code) => {
        if (overflow) {
          reject(new ReadLimitError());
          return;
        }
        if (processError) {
          reject(new HLedgerError("The hledger process failed.", 1, "", "hledger"));
          return;
        }
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        const exitCode = code ?? 1;
        const success = exitCode === 0;

        if (success) {
          resolve({
            success: true,
            stdout,
            stderr,
            exitCode: 0,
          });
        } else {
          reject(
            new HLedgerError(
              `HLedger command failed with exit code ${exitCode}`,
              exitCode,
              stderr,
              `hledger ${command}`,
            ),
          );
        }
      });

    });
  }

  /**
   * Combine multiple AbortSignals
   */
  private static combineSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    const onAbort = () => controller.abort();

    signals.forEach((signal) => {
      if (signal.aborted) {
        controller.abort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    });

    return controller.signal;
  }
}
