export async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write("backlog-sync <init|seed|hook|pull|status|flush>\n");
    return;
  }
  process.stdout.write(`backlog-sync: unknown command '${cmd}' (P0 stub)\n`);
}
