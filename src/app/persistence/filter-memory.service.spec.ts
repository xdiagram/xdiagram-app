import { Injector } from "@angular/core";

import { TauriApi } from "../core/tauri-api.service";
import { parseMemory, rememberExpression, rememberTable } from "../filter/memory";
import { FilterMemoryService } from "./filter-memory.service";

describe("FilterMemoryService", () => {
  it("keeps every change made at once, even before the file is read", async () => {
    let release!: (raw: string | null) => void;
    const saved: string[] = [];
    const api = {
      loadFilters: () => new Promise<string | null>((r) => (release = r)),
      saveFilters: async (_key: string, json: string) => {
        saved.push(json);
      },
    };
    const service = Injector.create({ providers: [{ provide: TauriApi, useValue: api }, FilterMemoryService] }).get(FilterMemoryService);
    const a = service.update("db", (m) => rememberExpression(m, "a = 1"));
    const b = service.update("db", (m) => rememberTable(m, "public.t", { sort: [{ column: "id", desc: true }] }));
    release(JSON.stringify({ v: 1, tables: {}, history: ["older"] }));
    await Promise.all([a, b]);
    await service.flush();
    const m = parseMemory(saved.at(-1) ?? null);
    expect(m.history).toEqual(["a = 1", "older"]);
    expect(m.tables["public.t"].sort).toEqual([{ column: "id", desc: true }]);
  });

  it("a failing change leaves the memory as it was", async () => {
    const api = { loadFilters: async () => null, saveFilters: async () => undefined };
    const service = Injector.create({ providers: [{ provide: TauriApi, useValue: api }, FilterMemoryService] }).get(FilterMemoryService);
    const error = console.error;
    console.error = () => undefined;
    await service.update("db", () => {
      throw new Error("boom");
    });
    console.error = error;
    await service.update("db", (m) => rememberExpression(m, "b = 2"));
    expect((await service.get("db")).history).toEqual(["b = 2"]);
    await service.flush();
  });
});
