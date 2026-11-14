/**
 * `text` as SQL line comments. Every line gets its own `-- `, so a line break inside a table name,
 * a note or a value cannot end the comment and leave runnable SQL behind it.
 */
export function sqlComment(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => `-- ${line}`)
    .join("\n");
}
