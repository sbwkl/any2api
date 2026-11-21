import { test, expect } from "bun:test";
import { codeartsProvider } from "./codearts";
import { codebuddyProvider } from "./codebuddy";

test("providers use distinct non-empty prefixes", () => {
  expect(codeartsProvider.prefix).toBe("/codearts");
  expect(codebuddyProvider.prefix).toBe("/codebuddy");
});