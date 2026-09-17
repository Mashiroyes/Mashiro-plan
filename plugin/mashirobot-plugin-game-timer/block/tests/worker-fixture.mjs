import { createBlockStore } from "../core/storage.mjs";

const store = createBlockStore(process.argv[2]);
store.upsert({ kind: "website", targetKey: "example.com", displayName: "example.com", expiresAt: null });
store.upsert({ kind: "software", targetKey: "qq", displayName: "QQ", expiresAt: null });
