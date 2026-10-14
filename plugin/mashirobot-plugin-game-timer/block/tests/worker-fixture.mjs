import { createBlockStore } from "../core/storage.mjs";

const store = createBlockStore(process.argv[2]);
store.upsert({ kind: "website", targetKey: "example.com", displayName: "example.com", expiresAt: null });
store.upsert({ kind: "software", targetKey: "qq", displayName: "QQ", expiresAt: null });
if (process.argv[3] === "expired-bilibili") {
  const now = new Date();
  store.upsert({ kind: "website", targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: null }, now);
  store.release({ targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: new Date(now.getTime() - 60_000).toISOString() }, now);
}
