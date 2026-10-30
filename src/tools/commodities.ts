import { z } from "zod";
import type { ToolMetadata } from "../base-tool.js";
import { SimpleReportTool } from "../base-tool.js";

const CommoditiesInputSchema = z.object({}).strict();

export class CommoditiesTool extends SimpleReportTool<
  typeof CommoditiesInputSchema
> {
  readonly metadata: ToolMetadata<typeof CommoditiesInputSchema> = {
    name: "hledger_commodities",
    description: "List commodities from the configured journal",
    schema: CommoditiesInputSchema,
  };

  constructor(journalFilePath?: string) {
    super(journalFilePath);
  }

  protected getCommand(): string {
    return "commodities";
  }

  protected buildArgs(
    _input: z.infer<typeof CommoditiesInputSchema>,
  ): string[] {
    return this.journalFilePath ? ["--file", this.journalFilePath] : [];
  }
}
