// CP3 Task 3.6d (ClaudeBWAI, 7 Oct 2026): host-<epoch>.webm.partial and .journal beside the finished
// <epoch>.webm are the verified raw original, not a finalize leftover. source-recovery.cjs reconcileEpoch
// re-checks them on every restart before it believes the finished file, so they must stay.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createSourceStore } from "../desktop/sources.cjs";

test("a finished source keeps its raw partial and journal, and leaves no staging file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blastcast-residue-"));
  try {
    const finalize = async (input, output) => { await fs.copyFile(input, output); return {}; };
    const store = createSourceStore({ folder: () => dir, finalize });
    const id = crypto.randomUUID(), epochId = crypto.randomUUID();
    assert.equal((await store.beginEpisode({ id, participants: [{ id: "host", label: "Host" }] })).ok, true);
    assert.equal((await store.beginSource("host", { episodeId: id, epochId, mimeType: "video/webm;codecs=vp8,opus",
      startedMonoMs: 100, hostStartedMs: 50, clockUncertaintyMs: 2, width: 1280, height: 720 })).ok, true);
    const data = Buffer.from("raw-media-bytes");
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
    assert.equal((await store.appendSource("host", { episodeId: id, epochId, sequence: 0, byteLength: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"), startMonoMs: 100, endMonoMs: 200 }, bytes)).ok, true);
    assert.equal((await store.finishSource("host", { episodeId: id, epochId, chunkCount: 1, endedMonoMs: 200 })).ok, true);
    assert.equal((await store.stopEpisode(id)).ok, true);
    assert.equal((await store.interrupt()).ok, true); // app quits before the episode is closed
    const names = (await fs.readdir(path.join(dir, `sources-${id}`))).sort();
    assert.deepEqual(names, [`${epochId}.webm`, "host-" + epochId + ".journal", "host-" + epochId + ".webm.partial", "metadata.json"].sort());
    assert.deepEqual(await fs.readFile(path.join(dir, `sources-${id}`, `host-${epochId}.webm.partial`)), data);
    // A restarted store (episode not closed) verifies the finished file against the retained raw pair.
    const again = createSourceStore({ folder: () => dir, finalize });
    const found = await again.recover();
    assert.equal(found.ok && found.recovered, true);
    assert.equal(again.status().allSourcesComplete, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
