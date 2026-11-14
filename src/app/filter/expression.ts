import type { ColKind } from "../core/tauri-api.service";
import { type Arg, type ColsNode, type CondNode, type CountOp, type FilterNode, type GroupNode, newId, type Op, type RelNode, SEARCH_COLUMN, type Span } from "./model";
import { parsePoint, printPoint } from "./relative-dates";
import type { RelOption } from "./relations";

/**
 * The filter as a line of text, for typing it in one go:
 *
 *   role = 'admin' and (created_at > -7d or email ~ "@gmail")
 *
 *   col = v   col != v   col < v   col <= v   col > v   col >= v
 *   col ~ v   col !~ v   col ^= v   col $= v   col matches v      (contains … regex; add `cs` for case)
 *   col in (a, b)   col not in (a, b)   col between a and b
 *   col is null   col is not null   col is empty   col is blank   col is padded
 *   col: today | yesterday | this week | this month | this year | last 7 days | 2026-11-14
 *   any ~ v                       (search in every text column)
 *   has orders   no orders   count(orders) >= 3   has orders(total > 100)   (related rows)
 *   ends_on < `starts_on`         (another column: back quotes on the right)
 *   not …   ( … )   and   or
 *
 * Values: 'quoted' or "quoted" (\ escapes), or bare (numbers, dates, -7d for "7 days ago").
 * Columns: bare names, or `back-quoted` when they need it.
 */

export class ParseError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set(["and", "or", "not", "in", "between", "is", "null", "empty", "blank", "padded", "matches", "cs", "any", "has", "no", "count"]);
const COUNT_OPS: CountOp[] = ["eq", "ne", "lt", "le", "gt", "ge"];
const COUNT_SYMBOL: Record<CountOp, string> = { eq: "=", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" };
const OPS: [string, Op | "span"][] = [
  ["!=", "ne"],
  ["<>", "ne"],
  ["<=", "le"],
  [">=", "ge"],
  ["!~", "notContains"],
  ["^=", "startsWith"],
  ["$=", "endsWith"],
  ["=", "eq"],
  ["<", "lt"],
  [">", "gt"],
  ["~", "contains"],
  [":", "span"],
];
const TEXT_OPS: Op[] = ["contains", "notContains", "startsWith", "endsWith", "regex"];

class Parser {
  pos = 0;
  /** The table whose columns and relationships names refer to (changes inside `has x(…)`). */
  table: string;
  constructor(
    readonly src: string,
    readonly rel: RelContext | null = null,
  ) {
    this.table = rel?.table ?? "";
  }

  ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  fail(message: string, from = this.pos, to = Math.max(from + 1, this.pos)): never {
    throw new ParseError(message, from, Math.min(to, Math.max(this.src.length, from + 1)));
  }

  /** Consumes a keyword (whole word, any case). */
  keyword(word: string): boolean {
    this.ws();
    const m = new RegExp(`^${word}(?![A-Za-z0-9_$])`, "i").exec(this.src.slice(this.pos));
    if (!m) return false;
    this.pos += m[0].length;
    return true;
  }

  char(c: string): boolean {
    this.ws();
    if (this.src[this.pos] !== c) return false;
    this.pos++;
    return true;
  }

  expect(c: string, what: string): void {
    if (!this.char(c)) this.fail(`Expected ${what}`);
  }

  or(): FilterNode {
    const items = [this.and()];
    while (this.keyword("or")) items.push(this.and());
    return items.length === 1 ? items[0] : { t: "group", id: newId(), op: "or", items };
  }

  and(): FilterNode {
    const items = [this.unary()];
    while (this.keyword("and")) items.push(this.unary());
    return items.length === 1 ? items[0] : { t: "group", id: newId(), op: "and", items };
  }

  unary(): FilterNode {
    this.ws();
    if (this.keyword("not")) {
      const inner = this.unary();
      if (inner.t === "group") return { ...inner, not: !inner.not };
      return { t: "group", id: newId(), op: "and", not: true, items: [inner] };
    }
    if (this.char("(")) {
      const inner = this.or();
      this.expect(")", "“)”");
      return inner;
    }
    return this.relation() ?? this.predicate();
  }

  /** `has x`, `has no x`, `no x`, `count(x) >= n`; `x(…)` narrows the related rows. */
  relation(): RelNode | null {
    this.ws();
    const rest = this.src.slice(this.pos);
    const count = /^count\s*\(/i.exec(rest);
    if (count) {
      this.pos += count[0].length;
      const target = this.relTarget();
      this.expect(")", "“)” after count(…");
      const at = this.pos;
      const op = this.op();
      if (!op || !COUNT_OPS.includes(op as CountOp)) this.fail("Expected =, !=, <, <=, > or >= after count(…)", at);
      this.ws();
      const n = /^\d{1,9}/.exec(this.src.slice(this.pos));
      if (!n) this.fail("Expected a whole number");
      this.pos += n[0].length;
      return { ...target, quant: { count: { op: op as CountOp, n: Number(n[0]) } } };
    }
    if (this.keyword("has")) return { ...this.relTargetAfter(this.keyword("no")), id: newId() };
    if (this.keyword("no")) return { ...this.relTargetAfter(true), id: newId() };
    return null;
  }

  private relTargetAfter(none: boolean): RelNode {
    return { ...this.relTarget(), quant: none ? "none" : "some" };
  }

  /** A relationship name (of the table being filtered) and, in parentheses, conditions on its rows. */
  relTarget(): Omit<RelNode, "quant"> {
    this.ws();
    const start = this.pos;
    let label: string;
    if (this.src[this.pos] === "`") label = this.ident();
    else {
      const m = /^[A-Za-z_][A-Za-z0-9_$.+]*/.exec(this.src.slice(this.pos));
      if (!m) this.fail("Expected the name of a related table");
      label = m[0];
      this.pos += m[0].length;
    }
    const options = this.rel ? this.rel.options(this.table) : [];
    const opt = options.find((o) => o.label === label) ?? options.find((o) => o.label.toLowerCase() === label.toLowerCase());
    if (!opt) {
      this.fail(options.length ? `No related table “${label}”: try ${options.map((o) => o.label).join(", ")}` : "This table has no known relationships", start, this.pos);
    }
    let filter: GroupNode | undefined;
    if (this.char("(")) {
      const outer = this.table;
      this.table = opt.tableId;
      const inner = this.or();
      this.table = outer;
      this.expect(")", "“)”");
      filter = inner.t === "group" && !inner.not ? inner : { t: "group", id: newId(), op: "and", items: [inner] };
    }
    return { t: "rel", id: newId(), label: opt.label, schema: opt.schema, table: opt.table, on: opt.on, ...(filter ? { filter } : {}) };
  }

  ident(): string {
    this.ws();
    const start = this.pos;
    if (this.src[this.pos] === "`") {
      let out = "";
      this.pos++;
      while (this.pos < this.src.length) {
        const c = this.src[this.pos++];
        if (c === "`") {
          if (this.src[this.pos] === "`") {
            out += "`";
            this.pos++;
            continue;
          }
          return out;
        }
        out += c;
      }
      this.fail("Unclosed `", start, this.pos);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_$.]*/.exec(this.src.slice(this.pos));
    if (!m) this.fail(this.pos >= this.src.length ? "Expected a column name" : `Expected a column name, not “${this.src[this.pos]}”`);
    this.pos += m[0].length;
    if (KEYWORDS.has(m[0].toLowerCase()) && m[0].toLowerCase() !== "any") this.fail(`“${m[0]}” is a keyword: write \`${m[0]}\` for a column`, start, this.pos);
    return m[0];
  }

  op(): Op | "span" | null {
    this.ws();
    for (const [sym, op] of OPS) {
      if (this.src.startsWith(sym, this.pos)) {
        this.pos += sym.length;
        return op;
      }
    }
    return null;
  }

  /** A value: quoted string, or a bare run of non-space characters. */
  value(): Arg {
    this.ws();
    const start = this.pos;
    const q = this.src[this.pos];
    if (q === "'" || q === '"') {
      let out = "";
      this.pos++;
      while (this.pos < this.src.length) {
        const c = this.src[this.pos++];
        if (c === "\\" && this.pos < this.src.length) {
          out += this.src[this.pos++];
          continue;
        }
        if (c === q) return out;
        out += c;
      }
      this.fail(`Unclosed ${q}`, start, this.pos);
    }
    const m = /^[^\s(),'"`]+/.exec(this.src.slice(this.pos));
    if (!m) this.fail(this.pos >= this.src.length ? "Expected a value" : `Expected a value, not “${this.src[this.pos]}”`);
    this.pos += m[0].length;
    const lower = m[0].toLowerCase();
    if (lower === "and" || lower === "or") this.fail("Expected a value", start, this.pos);
    return parsePoint(m[0]) ?? m[0];
  }

  span(): Span {
    this.ws();
    const rest = this.src.slice(this.pos);
    const tries: [RegExp, (m: RegExpExecArray) => Span][] = [
      [/^(today|yesterday)(?![A-Za-z])/i, (m) => m[1].toLowerCase() as Span],
      [/^this\s*(week|month|year)(?![A-Za-z])/i, (m) => ({ week: "thisWeek", month: "thisMonth", year: "thisYear" })[m[1].toLowerCase() as "week"] as Span],
      [/^last\s*(\d{1,4})\s*d(ays?)?(?![A-Za-z])/i, (m) => ({ lastDays: Number(m[1]) })],
      [/^(\d{4}-\d{2}-\d{2})(?![0-9])/, (m) => ({ day: m[1] })],
    ];
    for (const [re, make] of tries) {
      const m = re.exec(rest);
      if (m) {
        this.pos += m[0].length;
        return make(m);
      }
    }
    this.fail("Expected a period: today, yesterday, this week, this month, this year, last 7 days, or a date");
  }

  predicate(): CondNode | ColsNode {
    this.ws();
    const start = this.pos;
    const quoted = this.src[this.pos] === "`";
    const column = this.ident();
    if (!quoted && column.toLowerCase() === "any") {
      if (this.op() !== "contains") this.fail("Search every text column with: any ~ text", start, this.pos);
      const node: CondNode = { t: "cond", id: newId(), column: SEARCH_COLUMN, op: "contains", args: [this.value()] };
      if (this.keyword("cs")) node.cs = true;
      return node;
    }
    const cond = (op: Op, args: Arg[] = [], extra: Partial<CondNode> = {}): CondNode => ({ t: "cond", id: newId(), column, op, args, ...extra });
    if (this.keyword("is")) {
      const not = this.keyword("not");
      if (this.keyword("null")) return cond(not ? "notNull" : "isNull");
      if (not) this.fail("Expected “null” after “is not”");
      if (this.keyword("empty")) return cond("isEmpty");
      if (this.keyword("blank")) return cond("isBlank");
      if (this.keyword("padded")) return cond("isPadded");
      this.fail("Expected null, not null, empty, blank or padded");
    }
    const notIn = this.keyword("not");
    if (this.keyword("in")) {
      this.expect("(", "“(” after in");
      const args: Arg[] = [];
      if (!this.char(")")) {
        do args.push(this.value());
        while (this.char(","));
        this.expect(")", "“,” or “)”");
      }
      return cond(notIn ? "notIn" : "in", args);
    }
    if (notIn) this.fail("Expected “in” after “not”");
    if (this.keyword("between")) {
      const a = this.value();
      if (!this.keyword("and")) this.fail("Expected “and” in between … and …");
      return cond("between", [a, this.value()]);
    }
    let op: Op | "span" | null = this.keyword("matches") ? "regex" : this.op();
    if (!op) this.fail("Expected an operator (=, !=, <, >, ~, in, between, is, …)");
    if (op === "span") return cond("range", [], { span: this.span() });
    // A back-quoted name on the right is another column: ends_on < `starts_on`.
    this.ws();
    if (COUNT_OPS.includes(op as CountOp) && this.src[this.pos] === "`") {
      return { t: "cols", id: newId(), left: column, op: op as CountOp, right: this.ident() };
    }
    const node = cond(op, [this.value()]);
    if (TEXT_OPS.includes(op) && this.keyword("cs")) node.cs = true;
    return node;
  }
}

/** What `has …`, `no …` and `count(…)` refer to: the relationships of each table. */
export interface RelContext {
  /** The table the expression filters (`schema.table`). */
  table: string;
  options: (tableId: string) => RelOption[];
}

/**
 * Parses an expression into a filter tree (root: a group); throws `ParseError`. Empty text: empty
 * tree. Without `rel`, related-row conditions are refused.
 */
export function parseExpression(text: string, rel: RelContext | null = null): GroupNode {
  const p = new Parser(text, rel);
  p.ws();
  if (p.pos >= text.length) return { t: "group", id: newId(), op: "and", items: [] };
  const node = p.or();
  p.ws();
  if (p.pos < text.length) p.fail(`Unexpected “${text.slice(p.pos, p.pos + 12)}”: expected and, or or the end`, p.pos, text.length);
  if (node.t === "group" && !node.not) return node;
  return { t: "group", id: newId(), op: "and", items: [node] };
}

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$.]*$/;

function printIdent(name: string): string {
  return SAFE_IDENT.test(name) && !KEYWORDS.has(name.toLowerCase()) ? name : `\`${name.replace(/`/g, "``")}\``;
}

function printValue(a: Arg): string {
  if (typeof a !== "string") return printPoint(a);
  const bare = /^[^\s(),'"`]+$/.test(a) && !KEYWORDS.has(a.toLowerCase()) && !parsePoint(a) && !/^(=|!|<|>|~|\^|\$|:)/.test(a);
  return bare ? a : `'${a.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function printSpan(span: Span): string {
  if (typeof span === "object") return "day" in span ? span.day : `last ${span.lastDays} days`;
  return { today: "today", yesterday: "yesterday", thisWeek: "this week", thisMonth: "this month", thisYear: "this year" }[span];
}

const SYMBOL: Partial<Record<Op, string>> = {
  eq: "=",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  contains: "~",
  notContains: "!~",
  startsWith: "^=",
  endsWith: "$=",
  regex: "matches",
};

function printCond(c: CondNode): string {
  const col = c.column === SEARCH_COLUMN ? "any" : printIdent(c.column);
  const v = (i: number) => printValue(c.args[i] ?? "");
  switch (c.op) {
    case "isNull":
      return `${col} is null`;
    case "notNull":
      return `${col} is not null`;
    case "isEmpty":
      return `${col} is empty`;
    case "isBlank":
      return `${col} is blank`;
    case "isPadded":
      return `${col} is padded`;
    case "in":
    case "notIn":
      return `${col} ${c.op === "notIn" ? "not in" : "in"} (${c.args.map(printValue).join(", ")})`;
    case "between":
      return `${col} between ${v(0)} and ${v(1)}`;
    case "range":
      return c.span ? `${col}: ${printSpan(c.span)}` : `(${col} >= ${v(0)} and ${col} < ${v(1)})`;
    default:
      return `${col} ${SYMBOL[c.op]} ${v(0)}${c.cs ? " cs" : ""}`;
  }
}

function printRel(r: RelNode): string {
  const name = /^[A-Za-z_][A-Za-z0-9_$.+]*$/.test(r.label) && !KEYWORDS.has(r.label.toLowerCase()) ? r.label : `\`${r.label.replace(/`/g, "``")}\``;
  const inner = r.filter ? printExpression(r.filter) : "";
  const target = inner ? `${name}(${inner})` : name;
  if (r.quant === "some") return `has ${target}`;
  if (r.quant === "none") return `no ${target}`;
  return `count(${target}) ${COUNT_SYMBOL[r.quant.count.op]} ${r.quant.count.n}`;
}

/** The tree as expression text (switched-off nodes left out); `parseExpression` reads it back. */
export function printExpression(node: FilterNode, top = true): string {
  if (node.off) return "";
  if (node.t === "cond") return printCond(node);
  if (node.t === "rel") return printRel(node);
  if (node.t === "cols") return `${printIdent(node.left)} ${COUNT_SYMBOL[node.op]} \`${node.right.replace(/`/g, "``")}\``;
  const parts = node.items.map((i) => printExpression(i, false)).filter((s) => s);
  if (!parts.length) return "";
  const joined = parts.join(` ${node.op} `);
  if (node.not) return `not (${joined})`;
  return top || parts.length === 1 ? joined : `(${joined})`;
}

// ---------------------------------------------------------------------------------- suggestions

export interface Suggestion {
  label: string;
  /** Text that replaces [from, to). */
  insert: string;
  detail?: string;
}

export interface CompletionContext {
  columns: { name: string; kind: ColKind; enumValues?: string[] }[];
  /** Known values of a column (enum labels, cached profile values). */
  values?: (column: string) => string[];
  /** Names of the table's relationships (`has …`, `no …`, `count(…)`). */
  relations?: string[];
}

/** Suggestions at `caret`: columns, then operators for the column, then values, then and/or. */
export function complete(text: string, caret: number, ctx: CompletionContext): { from: number; to: number; items: Suggestion[] } {
  const before = text.slice(0, caret);
  const word = /[A-Za-z0-9_$.\-:]*$/.exec(before)?.[0] ?? "";
  const from = caret - word.length;
  const head = before.slice(0, from).replace(/\s+$/, "");
  const lw = word.toLowerCase();
  const pick = (items: Suggestion[]) => ({ from, to: caret, items: items.filter((s) => s.label.toLowerCase().startsWith(lw) && s.label.toLowerCase() !== lw).slice(0, 30) });
  const rels = ctx.relations ?? [];
  const columnItems = () => [
    ...ctx.columns.map((c) => ({ label: c.name, insert: `${printIdent(c.name)} `, detail: c.kind })),
    { label: "any", insert: "any ~ ", detail: "search every text column" },
    ...(rels.length
      ? [
          { label: "has", insert: "has ", detail: "rows with related rows" },
          { label: "no", insert: "no ", detail: "rows without related rows" },
          { label: "count", insert: "count(", detail: "number of related rows" },
        ]
      : []),
    { label: "not", insert: "not ", detail: "negate" },
  ];
  // After has / no / count(: a related table.
  if (/(^|[\s(])(has(\s+no)?|no)$/i.test(head) || /(^|[\s(])count\s*\($/i.test(head)) {
    return pick(rels.map((r) => ({ label: r, insert: /\bcount\s*\($/i.test(head) ? `${r}) ` : `${r} `, detail: "related rows" })));
  }
  // Start, or after and / or / not / "(": a column.
  if (!head || /(^|\s)(and|or|not)$/i.test(head) || head.endsWith("(") && !/\bin\s*\($/i.test(head)) return pick(columnItems());
  const colAtEnd = /(`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_$.]*)$/.exec(head);
  const colName = colAtEnd ? colAtEnd[1].replace(/^`|`$/g, "").replace(/``/g, "`") : null;
  const column = ctx.columns.find((c) => c.name === colName);
  // After a column: an operator.
  if (column && !/(=|<|>|~|:)\s*$/.test(head)) {
    const k = column.kind;
    const ops: Suggestion[] = [
      { label: "=", insert: "= " },
      { label: "!=", insert: "!= " },
      ...(k === "text" || k === "enum" || k === "json" || k === "other" ? [{ label: "~", insert: "~ ", detail: "contains" }, { label: "^=", insert: "^= ", detail: "starts with" }, { label: "$=", insert: "$= ", detail: "ends with" }] : []),
      ...(k !== "bool" && k !== "binary" ? [{ label: "<", insert: "< " }, { label: ">", insert: "> " }, { label: "between", insert: "between " }] : []),
      ...(k === "date" || k === "timestamp" || k === "timestamptz" ? [{ label: ":", insert: ": ", detail: "in a period" }] : []),
      { label: "in", insert: "in (" },
      { label: "is null", insert: "is null" },
      { label: "is not null", insert: "is not null" },
    ];
    return { from, to: caret, items: ops.filter((s) => !word || s.label.startsWith(word)) };
  }
  // After "column:" — a period.
  if (/:$/.test(head)) {
    return pick(["today", "yesterday", "this week", "this month", "this year", "last 7 days", "last 30 days"].map((p) => ({ label: p, insert: `${p} ` })));
  }
  // After "column op" or inside "in (": values of that column.
  const valueFor = /(`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_$.]*)\s*(=|!=|<>|<=|>=|<|>|~|!~|\^=|\$=|\bin\s*\((?:[^)]*,)?)\s*$/i.exec(head);
  if (valueFor) {
    const name = valueFor[1].replace(/^`|`$/g, "").replace(/``/g, "`");
    const col = ctx.columns.find((c) => c.name === name);
    const known = col ? [...(col.enumValues ?? []), ...(col.kind === "bool" ? ["true", "false"] : []), ...(ctx.values?.(name) ?? [])] : [];
    return pick([...new Set(known)].map((v) => ({ label: v, insert: `${printValue(v)} ` })));
  }
  // After a value: and / or.
  return pick([
    { label: "and", insert: "and " },
    { label: "or", insert: "or " },
  ]);
}
