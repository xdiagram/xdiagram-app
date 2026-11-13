import { classifyType, convertType } from "./type-map";

describe("type conversion", () => {
  it("classifies the type spellings introspection and DDL produce", () => {
    expect(classifyType("varchar(255)")).toEqual({ kind: "varchar", length: 255 });
    expect(classifyType("character varying(40)")).toEqual({ kind: "varchar", length: 40 });
    expect(classifyType("timestamp(6) with time zone")).toEqual({ kind: "timestamptz" });
    expect(classifyType("tinyint(1)", "mysql")).toEqual({ kind: "bool" });
    expect(classifyType("nvarchar(MAX)", "mssql")).toEqual({ kind: "text" });
    expect(classifyType("int(10) unsigned")).toEqual({ kind: "int" });
    expect(classifyType("money(19,4)", "mssql")).toEqual({ kind: "decimal", precision: 19, scale: 4 });
    expect(classifyType("numeric(10,2)")).toEqual({ kind: "decimal", precision: 10, scale: 2 });
    expect(classifyType("timestamp", "mssql")).toEqual({ kind: "binary" });
    expect(classifyType('"double precision"')).toEqual({ kind: "double" });
    expect(classifyType("text[]")).toBeNull();
    expect(classifyType("user_role")).toBeNull();
  });

  it("converts between dialects and keeps same-dialect types", () => {
    expect(convertType("int4", "postgres", "mssql")?.type).toBe("int");
    expect(convertType("uuid", "postgres", "mssql")?.type).toBe("uniqueidentifier");
    expect(convertType("bool", "postgres", "oracle")?.type).toBe("number(1)");
    expect(convertType("jsonb", "postgres", "mysql")?.type).toBe("json");
    expect(convertType("varchar(5000)", "postgres", "mssql")?.type).toBe("nvarchar(max)");
    expect(convertType("datetime2", "mssql", "postgres")?.type).toBe("timestamp");
    expect(convertType("bit", "mssql", "postgres")?.type).toBe("boolean");
    const tz = convertType("timestamptz", "postgres", "mysql");
    expect(tz?.type).toBe("datetime");
    expect(tz?.note).toContain("no zone");
    expect(convertType("timestamptz", "postgres", "postgres")).toBeNull();
    expect(convertType("inet", "postgres", "mysql")).toBeNull();
  });
});
