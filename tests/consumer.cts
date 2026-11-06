import {
  createVersionStore,
  createMemoryVersionAdapter,
  VersionStoreError,
  type DocumentSnapshot,
  type DocumentVersion,
  type VersionStore,
  type VersionState,
  type VersionAdapter,
} from '@lp-labs/document-version-store';
const adapter: VersionAdapter = createMemoryVersionAdapter();
const store: VersionStore = createVersionStore('doc', adapter);
const snapshot: DocumentSnapshot = {
  documentId: 'doc',
  title: 'Title',
  format: 'word',
  pages: [{ id: 'p', text: 'Body' }],
};
const commit: Promise<DocumentVersion> = store.commit('main', null, snapshot);
const state: Promise<VersionState> = store.read();
const code: string = new VersionStoreError('parent', 'bad').code;
// @ts-expect-error snapshots require a supported document format
const invalid: DocumentSnapshot = { ...snapshot, format: 'html' };
void [commit, state, code, invalid];
