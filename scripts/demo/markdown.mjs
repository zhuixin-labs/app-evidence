/** Just enough Markdown for the report and for one agent answer. */

const escapeHtml = (value) =>
  String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a>$1</a>");
}

function isTableRow(line) {
  return line.trim().startsWith("|");
}

function renderTable(rows) {
  const cells = rows
    .map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
    .filter((row) => !row.every((cell) => /^-{2,}$/.test(cell) || cell === ""));
  if (cells.length === 0) return "";
  const [head, ...body] = cells;
  return [
    "<table>",
    `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...body.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`),
    "</tbody></table>"
  ].join("");
}

export function mdToHtml(markdown) {
  const lines = String(markdown).split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("<details>")) {
      while (index < lines.length && !lines[index].includes("</details>")) index += 1;
      index += 1;
      out.push('<p class="muted">full inventory collapsed</p>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (isTableRow(line)) {
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }
      out.push(renderTable(rows));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""));
        index += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^#{1,6}\s+/.test(lines[index]) &&
      !isTableRow(lines[index]) &&
      !/^[-*]\s+/.test(lines[index]) &&
      !lines[index].startsWith("<details>")
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return out.join("\n");
}
