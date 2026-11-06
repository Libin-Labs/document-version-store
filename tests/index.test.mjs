import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVersionStore,
  createMemoryVersionAdapter,
  VersionStoreError,
} from '../dist/esm/index.js';

const snap = (text = 'one') => ({
  documentId: 'doc',
  title: 'Title',
  format: 'word',
  pages: [{ id: 'p', text }],
});
test('immutable snapshot ownership, branch parent checks and independent heads', async () => {
  const store = createVersionStore('doc', createMemoryVersionAdapter()),
    input = snap();
  const first = await store.commit('main', null, input);
  input.pages[0].text = 'mutated';
  assert.equal(first.snapshot.pages[0].text, 'one');
  assert.throws(() => {
    first.snapshot.pages[0].text = 'bad';
  });
  await store.branch('review', first.id);
  const review = await store.commit('review', first.id, snap('review'));
  const main = await store.commit('main', first.id, snap('main'));
  const state = await store.read();
  assert.equal(state.heads.review, review.id);
  assert.equal(state.heads.main, main.id);
  state.versions[0].snapshot.pages[0].text = 'bad';
  assert.equal((await store.read()).versions[0].snapshot.pages[0].text, 'one');
  await assert.rejects(store.commit('main', first.id, snap()), { code: 'parent' });
});
test('bounded retention preserves heads and records missing parent boundaries', async () => {
  const store = createVersionStore('doc', createMemoryVersionAdapter(), { maxVersions: 2 });
  let parent = null;
  for (let i = 0; i < 5; i++) parent = (await store.commit('main', parent, snap(String(i)))).id;
  const state = await store.read();
  assert.deepEqual(
    state.versions.map((v) => v.id),
    ['v4', 'v5'],
  );
  assert.deepEqual(state.boundaryParents, ['v3']);
  assert.equal(state.heads.main, 'v5');
  await assert.rejects(store.branch('old', 'v1'), { code: 'parent' });
});
test('concurrent commits race through adapter CAS, exactly one wins', async () => {
  const store = createVersionStore('doc', createMemoryVersionAdapter());
  const results = await Promise.allSettled([
    store.commit('main', null, snap('a')),
    store.commit('main', null, snap('b')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'conflict');
  assert.equal((await store.read()).versions.length, 1);
});
test('checkpoint recovery is CAS-protected and cannot reuse version IDs', async () => {
  const store = createVersionStore('doc', createMemoryVersionAdapter());
  const a = await store.commit('main', null, snap('a')),
    checkpoint = await store.read();
  const b = await store.commit('main', a.id, snap('b'));
  await store.recover(checkpoint);
  const c = await store.commit('main', a.id, snap('c'));
  assert.equal(b.id, 'v2');
  assert.equal(c.id, 'v3');
  assert.equal((await store.read()).generation, 4);
});
test('recover rejects corrupt parent chain, identity, branch head and snapshot', async () => {
  const store = createVersionStore('doc', createMemoryVersionAdapter());
  await store.commit('main', null, snap());
  const checkpoint = await store.read();
  for (const alter of [
    (s) => {
      s.versions[0].parent = 'v1';
    },
    (s) => {
      s.documentId = 'other';
    },
    (s) => {
      s.heads.main = 'v99';
    },
    (s) => {
      s.versions[0].snapshot.pages.push({ id: 'p', text: 'duplicate' });
    },
    (s) => {
      s.boundaryParents = ['v1'];
    },
  ]) {
    const bad = structuredClone(checkpoint);
    alter(bad);
    await assert.rejects(store.recover(bad));
  }
  assert.equal((await store.read()).generation, 1);
});
test('adapter failures and rejection do not partially commit', async () => {
  const adapter = createMemoryVersionAdapter(),
    store = createVersionStore('doc', adapter);
  await store.commit('main', null, snap());
  const reject = createVersionStore('doc', {
    read: adapter.read,
    compareAndSwap: async () => false,
  });
  await assert.rejects(reject.commit('main', 'v1', snap('new')), { code: 'conflict' });
  assert.equal((await store.read()).versions.length, 1);
  const failed = createVersionStore('doc', {
    read: async () => {
      throw new Error('read failed');
    },
    compareAndSwap: adapter.compareAndSwap,
  });
  await assert.rejects(failed.read(), /read failed/);
});
test('invalid snapshots, branch collision and retention bounds fail', async () => {
  assert.throws(() => createVersionStore('doc', createMemoryVersionAdapter(), { maxVersions: 0 }), {
    code: 'invalid',
  });
  const store = createVersionStore('doc', createMemoryVersionAdapter(), { maxVersions: 1 });
  await assert.rejects(store.commit('main', null, { ...snap(), documentId: 'wrong' }));
  await store.commit('main', null, snap());
  await assert.rejects(store.branch('main', 'v1'), { code: 'conflict' });
  await assert.rejects(store.branch('other', 'v1'));
  assert.ok(new VersionStoreError('invalid', 'bad') instanceof Error);
});
test('recover replaces corrupt records using the adapter generation without resetting sequence', async () => {
  const adapter = createMemoryVersionAdapter(),
    store = createVersionStore('doc', adapter);
  await store.commit('main', null, snap('saved'));
  const checkpoint = await store.read(),
    corrupt = structuredClone(checkpoint);
  corrupt.generation = 2;
  corrupt.sequence = 4;
  corrupt.versions[0].snapshot.documentId = 'wrong';
  assert.equal(await adapter.compareAndSwap(1, corrupt), true);
  await assert.rejects(store.read(), { code: 'invalid' });
  await store.recover(checkpoint);
  const restored = await store.read();
  assert.equal(restored.generation, 3);
  assert.equal(restored.sequence, 4);
  assert.equal(restored.versions[0].snapshot.pages[0].text, 'saved');
  assert.equal((await store.commit('main', 'v1', snap('later'))).id, 'v5');
});
