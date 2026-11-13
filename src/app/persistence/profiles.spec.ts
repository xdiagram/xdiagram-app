import { newProfile, newSsh, normalizeProfile, parseConnectionUrl, profileLabel, profileMeta, sshSecretId, toConnectionInput } from "./profiles.service";

describe("connection profiles", () => {
  it("parses URLs for every engine", () => {
    expect(parseConnectionUrl("postgres://u:p%40ss@db.example:6543/shop?sslmode=require")).toEqual({
      engine: "postgres", host: "db.example", port: 6543, database: "shop", user: "u", password: "p@ss", sslMode: "require",
    });
    expect(parseConnectionUrl("mariadb://root@127.0.0.1/shop")).toMatchObject({ engine: "mysql", port: 3306, database: "shop", user: "root" });
    expect(parseConnectionUrl("sqlserver://sa:pw@host")).toMatchObject({ engine: "mssql", port: 1433, database: "master" });
    expect(parseConnectionUrl("sqlite:C:/data/app.db")).toEqual({ engine: "sqlite", path: "C:/data/app.db" });
    expect(parseConnectionUrl("not a url")).toBeNull();
  });

  it("upgrades profiles saved before engines existed", () => {
    const old = { id: "x", name: "", host: "h", port: 5432, database: "d", user: "u", sslMode: "prefer", schemas: [] } as never;
    const p = normalizeProfile(old);
    expect(p.engine).toBe("postgres");
    expect(p.path).toBe("");
    expect(toConnectionInput(p).engine).toBe("postgres");
  });

  it("builds engine-specific connection input and labels", () => {
    const lite = { ...newProfile("sqlite"), path: "C:\\data\\shop.db" };
    expect(toConnectionInput(lite)).toEqual({ engine: "sqlite", path: "C:\\data\\shop.db", profileId: lite.id });
    expect(profileLabel(lite)).toBe("shop.db");
    const ms = newProfile("mssql");
    expect(ms.port).toBe(1433);
    expect(toConnectionInput(ms, "pw")).toMatchObject({ engine: "mssql", trustCert: true, password: "pw" });
  });
  it("carries SSH tunnel settings into the connection input", () => {
    // profiles saved before SSH support have none
    expect(normalizeProfile({ id: "old", name: "x" } as never).ssh).toBeNull();
    const p = { ...newProfile("postgres"), id: "p1", host: "localhost", user: "app", database: "shop" };
    expect(toConnectionInput(p, "pw").ssh).toBeUndefined();
    const viaKey = { ...p, ssh: { ...newSsh(), host: " bastion.example ", user: "ops", auth: "key" as const, keyPath: "C:/keys/id_ed25519" } };
    expect(toConnectionInput(viaKey, "pw", "passphrase").ssh).toEqual({
      host: "bastion.example", port: 22, user: "ops", auth: "key", keyPath: "C:/keys/id_ed25519", secret: "passphrase",
    });
    // password sign-in sends no key path; an empty secret means "use the keychain"
    expect(toConnectionInput({ ...viaKey, ssh: { ...viaKey.ssh, auth: "password" } }).ssh).toEqual({
      host: "bastion.example", port: 22, user: "ops", auth: "password", keyPath: undefined, secret: undefined,
    });
    expect(profileMeta(viaKey)).toBe("app@localhost:5432/shop via bastion.example");
    expect(sshSecretId("p1")).toBe("ssh:p1");
    // SQLite has no network, so no tunnel
    expect(toConnectionInput({ ...newProfile("sqlite"), id: "s", path: "a.db", ssh: newSsh() }).ssh).toBeUndefined();
  });
});
