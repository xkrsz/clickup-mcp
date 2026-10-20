export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1b1b1f; --muted: #5f6068; --bg: #fbfbfc; --card: #f1f1f4; --accent: #7b68ee; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a1ab; --bg: #141418; --card: #1f1f25; } }
  body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 36px 0 8px; }
  p, li { color: var(--muted); }
  code { font: 13.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: var(--card); padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
  .endpoint { display: inline-block; background: var(--card); padding: 6px 12px; border-radius: 8px; border-left: 3px solid var(--accent); }
  .warn { color: #c2410c; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
  td { padding: 6px 8px; border-top: 1px solid var(--card); vertical-align: top; }
  td:first-child { white-space: nowrap; }
  a { color: var(--accent); }
  button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--card); background: var(--card); color: var(--fg); cursor: pointer; margin-right: 8px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
