/** Tooltip of the column filter boxes: the quick syntax (see `quick-syntax.ts`). */
export const QUICK_HELP = [
  "Enter applies, empty clears.",
  "abc  equals   ·   !=x  not equal   ·   >5  >=5  <5  <=5   ·   10..20  between",
  "~x  contains   ·   !~x  does not contain   ·   ^x  starts with   ·   *x  ends with   ·   /re/  regex",
  "null   ·   !null   ·   ''  empty   ·   \"NULL\"  the text NULL   ·   1,2,3  one of (not for text)",
  "Dates: today · yesterday · thisweek · thismonth · thisyear · last7d · >-7d · 2026-11-14 (that whole day)",
].join("\n");
