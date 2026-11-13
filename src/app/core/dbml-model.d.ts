/**
 * `@dbml/core`'s `Database` model class on its own (mapped in tsconfig.json), so the parse worker
 * gets the model without `@dbml/core`'s SQL parsers, which are most of its size.
 */
declare module "#dbml-model" {
  import type { Database } from "@dbml/core";

  const DatabaseModel: new (raw: unknown) => Database;
  export default DatabaseModel;
}
