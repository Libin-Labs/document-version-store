# @lp-labs/document-version-store

Immutable paged-document snapshots, checked branch parents, bounded retention and adapter CAS recovery.

Original, independent MIT implementation. Zero runtime, peer or sibling dependencies. Requires Node.js 18+; strict TypeScript declarations support both ESM and CommonJS.

## Install

```sh
npm install @lp-labs/document-version-store
```

## Quickstart

```js
import {
  createVersionStore,
  createMemoryVersionAdapter,
  VersionStoreError,
} from '@lp-labs/document-version-store';
const store = createVersionStore('doc', createMemoryVersionAdapter(), { maxVersions: 4 });
const first = await store.commit('main', null, {
  documentId: 'doc',
  title: 'Draft',
  format: 'word',
  pages: [{ id: 'p1', text: 'Hello' }],
});
await store.branch('review', first.id);
const state = await store.read();
await store.recover(state);
if (
  (await store.read()).heads.review !== first.id ||
  !(new VersionStoreError('invalid', 'Example') instanceof Error)
)
  throw new Error('Version mismatch');
```

## API and types

`createVersionStore(documentId, adapter: VersionAdapter, { maxVersions? }): VersionStore` stores a single document identity. `DocumentSnapshot` has documentId, title, format pdf/word/text, and pages of unique id/text. `commit(branch, parent, snapshot): Promise<DocumentVersion>` requires parent exactly equal to the current branch head; versions have generated vN id, parent and branch. `branch(name, from)` creates a named head from a retained version or null. `read()` returns a detached `VersionState` with schema=1, generation, sequence, versions, heads and boundaryParents. `recover(state)` validates a checkpoint then atomically replaces adapter state, advancing current generation and preserving the maximum sequence. `VersionStoreError.code`: invalid, conflict, parent, capacity. `createMemoryVersionAdapter()` provides detached reads and atomic generation CAS for tests/single-process use.

## Customize

Implement read() and atomic compareAndSwap(expectedGeneration|null,state): Promise<boolean> for durable storage. Adapter methods must return finite plain data and must not mutate supplied state. CAS conflicts are explicit, not automatically retried; reload before deciding the next parent. Recover can replace corrupt version records if adapter identity, sequence and generation remain valid; it does not salvage an unreadable adapter. No filesystem, PDF/Word decoder, binary content or metadata migration is bundled. Recovery validates checkpoint data but does not authenticate it.

## Errors and bounds

maxVersions defaults to 64 (1..256); up to min(64,maxVersions) branches; 1000 pages and 1,000,000 text units per snapshot, 8,000,000 aggregate retained text units. O(retained snapshot data) validation/copying per operation. Retention prunes oldest non-head versions in insertion order, never heads; missing immediate ancestors are explicitly listed in bounded boundaryParents. Parent ids strictly precede child ids. History behind a retention boundary is unavailable. Returned commits freeze nested snapshot pages; read returns editable detached checkpoint copies. Original document contracts and CAS persistence differ from generic design-history undo/redo.

Invalid runtime inputs throw TypeError/RangeError or the documented typed error. Adapter errors propagate unchanged unless specifically noted; asynchronous methods reject. Inputs must be ordinary typed data, not hostile proxies or accessors. No I/O happens at import time. All runtime exports are documented above and the example executes without optional packages.

## Development

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm test
npm run format:check
```

Build emits dist/esm and dist/cjs with matching declarations. Tests use Node's test runner; consumer.mts and consumer.cts validate meaningful bare-package imports and expected type errors. Only TypeScript ^5.9.3 and Prettier ^3.6.2 are development dependencies.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
