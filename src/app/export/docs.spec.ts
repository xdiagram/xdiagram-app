import { escapeHtml, renderHtml } from "./doc-html";
import { githubSlug, mdCell, mermaidCardinality, mermaidEntity, mermaidType, renderMarkdown } from "./doc-markdown";
import type { DocModel } from "./doc-model";

const model: DocModel = {
  title: "Shop",
  source: "postgres@localhost/shop",
  generatedAt: "2026-11-13T10:00:00.000Z",
  tables: [
    {
      id: "public.users",
      schema: "public",
      name: "users",
      label: "users",
      note: "Accounts | people",
      group: null,
      columns: [
        { name: "id", type: "bigint", pk: true, unique: false, notNull: true, increment: true, defaultValue: null, note: null, references: [], checks: [], enumValues: null, cardinality: null },
        { name: "role", type: "user_role", pk: false, unique: false, notNull: true, increment: false, defaultValue: "'member'", note: "a <b>role</b>", references: [], checks: [], enumValues: ["admin", "member"], cardinality: null },
      ],
      indexes: [{ name: "users_pkey", columns: ["id"], unique: true, pk: true, type: "btree" }],
      checks: [],
      referencedBy: [{ table: "billing.orders", columns: ["user_id"], toColumns: ["id"] }],
      facts: null,
      fkUsage: [],
    },
    {
      id: "billing.orders",
      schema: "billing",
      name: "orders",
      label: "billing.orders",
      note: null,
      group: "Billing",
      columns: [
        { name: "user_id", type: "double precision", pk: false, unique: false, notNull: false, increment: false, defaultValue: null, note: null, references: [{ table: "public.users", columns: ["id"] }], checks: ["user_id > 0"], enumValues: null, cardinality: null },
      ],
      indexes: [],
      checks: [{ name: "c1", expression: "user_id > 0" }],
      referencedBy: [],
      facts: null,
      fkUsage: [{ columns: ["user_id"], target: "public.users", calls: 0 }],
    },
  ],
  enums: [{ id: "public.user_role", name: "user_role", note: null, values: [{ name: "admin", note: null }, { name: "member", note: "default" }] }],
  relations: [{ from: { table: "billing.orders", columns: ["user_id"], many: true }, to: { table: "public.users", columns: ["id"], many: false }, name: null }],
  groups: [{ name: "Billing", tables: ["billing.orders"] }],
  xray: null,
};

describe("markdown docs", () => {
  it("escapes table cells", () => {
    expect(mdCell("a|b")).toBe("a\\|b");
    expect(mdCell("line1\nline2")).toBe("line1<br>line2");
    expect(mdCell(null)).toBe("");
  });

  it("builds GitHub anchors", () => {
    expect(githubSlug("billing.orders")).toBe("billingorders");
    expect(githubSlug("My Table")).toBe("my-table");
  });

  it("sanitizes Mermaid identifiers and types", () => {
    expect(mermaidEntity("public.users")).toBe("users");
    expect(mermaidEntity("billing.orders")).toBe("billing_orders");
    expect(mermaidType("double precision")).toBe("double_precision");
    expect(mermaidType("varchar(255)")).toBe("varchar(255)");
    expect(mermaidType("numeric(10,2)")).toBe("numeric(10_2)");
    expect(mermaidType("billing.invoice_status")).toBe("billing_invoice_status");
    expect(mermaidType("text[]")).toBe("text[]");
  });

  it("uses crow's-foot cardinality with the parent on the left", () => {
    expect(mermaidCardinality(model.relations[0])).toBe("||--o{");
    expect(mermaidCardinality({ ...model.relations[0], from: { ...model.relations[0].from, many: false } })).toBe("||--o|");
  });

  it("renders the document", () => {
    const md = renderMarkdown(model);
    expect(md).toContain("# Shop");
    expect(md).toContain("- [users](#users) — Accounts \\| people");
    expect(md).toContain("```mermaid\nerDiagram");
    expect(md).toContain('  users ||--o{ billing_orders : "user_id"');
    expect(md).toContain("| user_id | `double precision` | FK |  | users.id | check: `user_id > 0` |");
    expect(md).toContain("**X-ray:** never joined in the recorded workload: user_id → users");
    expect(md).toContain("### user_role");
  });
});

describe("html docs", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("renders a self-contained page with anchors, links and escaped content", () => {
    const html = renderHtml(model, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('id="t-public-users"');
    expect(html).toContain('<a href="#t-public-users">users.id</a>');
    expect(html).toContain("a &lt;b&gt;role&lt;/b&gt;");
    expect(html).toContain('<div class="diagram"');
    expect(html).not.toMatch(/<script src=|<link [^>]*href=/);
  });
});
