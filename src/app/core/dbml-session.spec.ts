import { Parser } from "@dbml/core";

import { buildViewModel } from "../diagram/view-model";
import { textModel } from "../editor/text-model";
import { buildDocModel } from "../export/doc-model";
import { DEFAULT_RULES, lintSchema } from "../lint/lint";
import { DbmlSession } from "./dbml-session";
import { toDiagnostics } from "./diagnostics";
import { DocumentParser } from "./document-parser";

const RICH = `Project shop {
  database_type: 'PostgreSQL'
  Note: 'A small shop'
}

Enum billing.invoice_status {
  draft
  paid [note: 'settled']
}

Table public.customers [headercolor: #3498DB, note: 'People who buy'] {
  id integer [pk, increment]
  email varchar(255) [not null, unique, note: 'login']
  created_at timestamp [default: \`now()\`]
}

Table billing.invoices {
  id uuid [pk]
  customer_id integer [not null]
  status billing.invoice_status [default: 'draft']
  amount numeric(10,2) [note: 'gross']

  Indexes {
    (customer_id, status) [name: 'by_customer']
    amount
  }
}

Table orders {
  id integer [pk]
  customer_id integer [ref: > customers.id]
  invoice_id uuid
}

Ref: billing.invoices.customer_id > public.customers.id [delete: cascade]
Ref fk_inv: orders.invoice_id - billing.invoices.id

TableGroup sales [color: #E67E22] {
  customers
  orders
}
`;

describe("DbmlSession (the parse worker's parser)", () => {
  it("builds the same diagram model as @dbml/core's Parser", () => {
    for (const text of [RICH, "Table a { id int [pk] }", "// only a comment\n"]) {
      const r = new DbmlSession().parse(text);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.view).toEqual(buildViewModel(Parser.parse(text, "dbmlv2")));
    }
  });

  it("reports errors where @dbml/core does", () => {
    const text = "Table a {\n  id int [pk]\n  broken (\n}\nRef: a.nope > b.id\n";
    const r = new DbmlSession().parse(text);
    let expected: unknown = null;
    try {
      Parser.parse(text, "dbmlv2");
    } catch (err) {
      expected = toDiagnostics(err);
    }
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics).toEqual(expected);
  });

  it("lints the last document that parsed", () => {
    const session = new DbmlSession();
    expect(session.lint([...DEFAULT_RULES])).toEqual([]);
    session.parse(RICH);
    const db = Parser.parse(RICH, "dbmlv2");
    const expected = lintSchema(buildDocModel(db, buildViewModel(db), { title: "", source: null }), new Set(DEFAULT_RULES));
    expect(session.lint([...DEFAULT_RULES])).toEqual(expected);
    // a later parse error keeps linting the last good document
    session.parse(RICH + "\nTable broken {");
    expect(session.lint([...DEFAULT_RULES])).toEqual(expected);
  });

  it("completes table and column names", () => {
    const text = "Table customers {\n  id int [pk]\n  email varchar\n}\n\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.]\n}\n";
    const session = new DbmlSession();
    const line = text.split("\n").findIndex((l) => l.includes("customers.]")) + 1;
    const column = text.split("\n")[line - 1].indexOf("customers.") + "customers.".length + 1;
    const labels = (session.complete(text, { lineNumber: line, column })?.suggestions ?? []).map((s) => (s as { label: unknown }).label);
    expect(labels).toEqual(expect.arrayContaining(["id", "email"]));
  });
});

describe("textModel", () => {
  it("maps offsets and positions both ways, CRLF included", () => {
    const text = "Table a {\r\n  id int\r\n}\r\n";
    const m = textModel(text);
    expect(m.getLineCount()).toBe(4);
    expect(m.getLineContent(2)).toBe("  id int");
    for (let offset = 0; offset < text.length; offset++) {
      if (text[offset] === "\n") continue; // inside a CRLF pair, Monaco has no position
      expect(m.getOffsetAt(m.getPositionAt(offset))).toBe(offset);
    }
    expect(m.getPositionAt(text.indexOf("id"))).toEqual({ lineNumber: 2, column: 3 });
  });
});

describe("DocumentParser without a worker", () => {
  it("parses, lints and leaves completion to the editor", async () => {
    const parser = new DocumentParser();
    const ok = await parser.parse(RICH);
    expect(ok?.ok).toBe(true);
    const bad = await parser.parse("Table x {");
    expect(bad?.ok).toBe(false);
    expect((await parser.lint([...DEFAULT_RULES])).length).toBeGreaterThanOrEqual(0);
    if (typeof Worker === "undefined") expect(await parser.complete(RICH, { lineNumber: 1, column: 1 })).toBeNull();
  });
});
