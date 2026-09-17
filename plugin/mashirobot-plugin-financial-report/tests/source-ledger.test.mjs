import assert from "node:assert/strict";
import test from "node:test";

import { loadCurriculum } from "../core/curriculum.mjs";

const pluginRoot = new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));

test("source ledger contains eight verified official PDFs", () => {
  const curriculum = loadCurriculum(pluginRoot);
  assert.equal(curriculum.sources.length, 8);
  assert.equal(new Set(curriculum.sources.map((source) => source.sourceId)).size, 8);
  for (const source of curriculum.sources) {
    const url = new URL(source.officialUrl);
    assert.equal(url.protocol, "https:");
    assert.match(url.hostname, /(?:cninfo\.com\.cn|hkexnews\.hk|tencent\.com)$/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
  }
});

test("every source has at least two traceable fact/page pairs", () => {
  const curriculum = loadCurriculum(pluginRoot);
  const counts = new Map(curriculum.sources.map((source) => [source.sourceId, 0]));
  for (const lesson of [...curriculum.financialReports, ...curriculum.prospectuses]) {
    for (const fact of lesson.facts) {
      assert.ok(Number.isInteger(fact.pdfPage) && fact.pdfPage > 0);
      const sourceId = fact.sourceId ?? lesson.sourceId;
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }
  for (const [sourceId, count] of counts) {
    assert.ok(count >= 2, `${sourceId} 只有 ${count} 个事实/页码对`);
  }
});
