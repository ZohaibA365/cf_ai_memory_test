// Reads the committed filler pool from disk (for Node scripts; the Worker
// bundles it via src/experiment/data.ts instead).
import { readFileSync } from "node:fs";
import { fillerPoolSchema, type FillerPair } from "../src/experiment/conversation";

export function loadFillerPoolFromDisk(): FillerPair[] {
  return fillerPoolSchema.parse(JSON.parse(readFileSync("data/filler.json", "utf8"))).pairs;
}
