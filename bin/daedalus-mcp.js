#!/usr/bin/env node
import { runTsxEntry } from "./run-tsx-entry.js";

runTsxEntry("src/cli.ts", ["mcp", "external"]);
