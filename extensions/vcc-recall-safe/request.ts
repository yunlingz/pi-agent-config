interface Modifiers {
  page?: number;
  scope?: string;
}

type RecallArguments = Modifiers & ({ query: string } | { range: [number, number] } | { expand: number[] } | { mode: "touched" });

const ACTIONS = new Set(["search", "range", "expand", "touched", "file"]);

function fail(message: string): never {
  throw new Error(message);
}

function parseIndex(value: string, label: string) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    fail(`${label} must be a non-negative integer.`);
  }
  return index;
}

function parseModifiers(input: string) {
  let payload = input.trim();
  let page;
  let scope;

  while (true) {
    const match = payload.match(/(?:^|\s)(?:page:(\d+)|scope:(lineage|all))\s*$/i);
    if (!match) break;
    payload = payload.slice(0, match.index).trimEnd();

    if (match[1]) {
      if (page !== undefined) fail("Specify page only once.");
      page = parseIndex(match[1], "Page");
      if (page < 1) fail("Page must be at least 1.");
    } else {
      if (scope !== undefined) fail("Specify scope only once.");
      scope = match[2].toLowerCase();
    }
  }

  return { payload, page, scope };
}

function addModifiers<T extends RecallArguments>(args: T, page: number | undefined, scope: string | undefined, supportsPage = true): T {
  if (!supportsPage && page !== undefined) {
    fail("This action does not support page.");
  }
  if (page !== undefined) args.page = page;
  if (scope !== undefined) args.scope = scope;
  return args;
}

function parseRange(payload: string): [number, number] {
  const bracketed = payload.startsWith("[") || payload.endsWith("]");
  if (bracketed && !(payload.startsWith("[") && payload.endsWith("]"))) {
    fail("Range brackets must be paired.");
  }
  const match = payload.match(/^\[?\s*#?(\d+)\s*(?:(?:-|\.\.|,|to)\s*#?(\d+)\s*)?\]?$/i);
  if (!match) fail("Range input must be one index or a from-to pair.");
  const first = parseIndex(match[1], "Range index");
  const second = parseIndex(match[2] ?? match[1], "Range index");
  return first <= second ? [first, second] : [second, first];
}

function parseExpand(payload: string) {
  const bracketed = payload.startsWith("[") || payload.endsWith("]");
  if (bracketed && !(payload.startsWith("[") && payload.endsWith("]"))) {
    fail("Expand brackets must be paired.");
  }
  const value = bracketed ? payload.slice(1, -1).trim() : payload;
  if (!/^#?\d+(?:[\s,]+#?\d+)*$/.test(value)) {
    fail("Expand input must contain one or more entry indices.");
  }
  return [...new Set((value.match(/\d+/g) ?? []).map((item) => parseIndex(item, "Expand index")))];
}

function parseFile(payload: string) {
  const match = payload.match(/^#(\d+)(?::(.+))?$/);
  if (!match) fail("File input must use #N or #N:path syntax.");
  parseIndex(match[1], "File entry index");
  return payload;
}

export function buildRecallArguments(action: unknown, input: unknown): RecallArguments {
  if (typeof action !== "string") fail("Action must be text.");
  if (typeof input !== "string") fail("Input must be text.");

  const normalizedAction = action.trim().toLowerCase();
  if (!ACTIONS.has(normalizedAction)) {
    fail(`Unsupported action: ${action}.`);
  }

  const { payload, page, scope } = parseModifiers(input);
  switch (normalizedAction) {
    case "search":
      if (!payload) fail("Search input cannot be empty.");
      return addModifiers({ query: payload }, page, scope);
    case "range":
      if (!payload) fail("Range input cannot be empty.");
      return addModifiers({ range: parseRange(payload) }, page, scope);
    case "expand":
      if (!payload) fail("Expand input cannot be empty.");
      return addModifiers({ expand: parseExpand(payload) }, page, scope, false);
    case "touched":
      if (payload) fail("Touched input can contain only page or scope modifiers.");
      return addModifiers({ mode: "touched" }, page, scope);
    case "file":
      if (!payload) fail("File input cannot be empty.");
      return addModifiers({ query: parseFile(payload) }, page, scope, false);
    default:
      return fail(`Unsupported action: ${action}.`);
  }
}
