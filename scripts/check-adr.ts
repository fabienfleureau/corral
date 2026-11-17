// Structural checks only; reviewers decide whether a change needs an ADR.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkAdrs(directory: string): string[] {
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(directory).sort();
  } catch (error) {
    return [`Cannot read ADR directory ${directory}: ${String(error)}`];
  }
  let index = "";
  try {
    index = readFileSync(join(directory, "README.md"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  } catch {
    errors.push("Missing or unreadable ADR index README.md");
  }
  const links = new Set([...index.matchAll(/\[[^\]]+\]\((?:\.\/)?([^\s)]+\.md)\)/g)].map((match) => match[1]));
  const records = files.filter((file) => file !== "README.md" && file !== "template.md");
  if (!records.length) errors.push("No ADR records found");
  const numbers = new Set<string>();
  for (const file of records) {
    const match = file.match(/^(?!0000)(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
    if (!match) {
      errors.push(`Invalid ADR filename ${file}: expected NNNN-lowercase-slug.md, starting at 0001`);
      continue;
    }
    if (numbers.has(match[1])) errors.push(`Duplicate ADR number ${match[1]}: ${file}`);
    numbers.add(match[1]);
    if (!links.has(file)) errors.push(`ADR ${file} is not linked from README.md`);
    try {
      const content = readFileSync(join(directory, file), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      const title = /^# +\S[^\r\n]*$/m.exec(content);
      const body = title ? content.slice(title.index + title[0].length).replace(/^#{1,6}\s+.*$/gm, "").trim() : "";
      if (!title || !body) errors.push(`ADR ${file} needs a title and decision text`);
    } catch {
      errors.push(`Cannot read ADR ${file}`);
    }
  }
  for (const link of links) {
    if (/^\d/.test(link) && !records.includes(link)) errors.push(`ADR index links to missing record ${link}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL("../docs/adr/", import.meta.url));
  const errors = checkAdrs(directory);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ADR check passed");
  }
}
