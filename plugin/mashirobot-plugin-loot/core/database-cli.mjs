import { closeLootStore, createLootStore } from "./store.mjs";

const args = process.argv.slice(2);
const index = args.indexOf("--sqlite");
if (index < 0 || !args[index + 1]) throw new Error("需要 --sqlite。");
const store = createLootStore(args[index + 1]);
try {
  store.initialize();
  store.dropLegacyNotes();
  store.initialize();
  process.stdout.write(JSON.stringify({ ok: true, sqlitePath: store.sqlitePath }) + "\n");
} finally {
  closeLootStore(args[index + 1]);
}
