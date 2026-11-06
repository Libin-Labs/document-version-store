export interface DocumentSnapshot {
  documentId: string;
  title: string;
  format: 'pdf' | 'word' | 'text';
  pages: readonly { id: string; text: string }[];
}
export interface DocumentVersion {
  id: string;
  parent: string | null;
  branch: string;
  snapshot: DocumentSnapshot;
}
export interface VersionState {
  schema: 1;
  documentId: string;
  generation: number;
  sequence: number;
  versions: DocumentVersion[];
  heads: Record<string, string | null>;
  boundaryParents: string[];
}
export interface VersionAdapter {
  read(): Promise<VersionState | null>;
  compareAndSwap(expectedGeneration: number | null, state: VersionState): Promise<boolean>;
}
export interface VersionStore {
  read(): Promise<VersionState>;
  commit(
    branch: string,
    parent: string | null,
    snapshot: DocumentSnapshot,
  ): Promise<DocumentVersion>;
  branch(name: string, from: string | null): Promise<void>;
  recover(state: VersionState): Promise<void>;
}
export class VersionStoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'parent' | 'capacity',
    message: string,
  ) {
    super(message);
    this.name = 'VersionStoreError';
  }
}
function invalid(message: string): never {
  throw new VersionStoreError('invalid', message);
}
function name(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value))
    invalid('Invalid identifier');
}
function snapshot(value: DocumentSnapshot, documentId: string): DocumentSnapshot {
  if (
    !value ||
    value.documentId !== documentId ||
    !['pdf', 'word', 'text'].includes(value.format) ||
    typeof value.title !== 'string' ||
    value.title.length > 4096 ||
    !Array.isArray(value.pages) ||
    value.pages.length > 1000
  )
    invalid('Invalid document snapshot');
  let size = value.title.length;
  const ids = new Set<string>();
  const pages = value.pages.map((p) => {
    name(p.id);
    if (ids.has(p.id) || typeof p.text !== 'string') invalid('Invalid document page');
    ids.add(p.id);
    size += p.text.length;
    if (size > 1_000_000) throw new VersionStoreError('capacity', 'Snapshot text limit');
    return Object.freeze({ id: p.id, text: p.text });
  });
  return Object.freeze({
    documentId,
    title: value.title,
    format: value.format,
    pages: Object.freeze(pages),
  });
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function createMemoryVersionAdapter(): VersionAdapter {
  let state: VersionState | null = null;
  return {
    read: async () => (state === null ? null : copy(state)),
    async compareAndSwap(expected, next) {
      if ((state?.generation ?? null) !== expected) return false;
      state = copy(next);
      return true;
    },
  };
}
export function createVersionStore(
  documentId: string,
  adapter: VersionAdapter,
  options: { maxVersions?: number } = {},
): VersionStore {
  name(documentId);
  const max = options.maxVersions ?? 64;
  if (!Number.isSafeInteger(max) || max < 1 || max > 256) invalid('Invalid retention');
  function empty(): VersionState {
    return {
      schema: 1,
      documentId,
      generation: 0,
      sequence: 0,
      versions: [],
      heads: { main: null },
      boundaryParents: [],
    };
  }
  function validate(input: VersionState): VersionState {
    if (
      !input ||
      input.schema !== 1 ||
      input.documentId !== documentId ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0 ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      !Array.isArray(input.versions) ||
      input.versions.length > max ||
      !input.heads ||
      typeof input.heads !== 'object' ||
      Array.isArray(input.heads) ||
      !Array.isArray(input.boundaryParents) ||
      input.boundaryParents.length > max
    )
      invalid('Invalid version state');
    const versions: DocumentVersion[] = [],
      ids = new Set<string>();
    let total = 0;
    const number = (id: string) => {
      if (
        typeof id !== 'string' ||
        id.length > 17 ||
        !/^v[1-9]\d*$/u.test(id) ||
        !Number.isSafeInteger(Number(id.slice(1))) ||
        Number(id.slice(1)) > input.sequence
      )
        invalid('Invalid version ID');
      return Number(id.slice(1));
    };
    for (const v of input.versions) {
      number(v.id);
      name(v.branch);
      if (ids.has(v.id)) invalid('Duplicate version ID');
      ids.add(v.id);
      const snap = snapshot(v.snapshot, documentId);
      total += snap.title.length + snap.pages.reduce((sum, p) => sum + p.text.length, 0);
      if (total > 8_000_000) throw new VersionStoreError('capacity', 'Store text limit');
      versions.push({ id: v.id, parent: v.parent, branch: v.branch, snapshot: snap });
    }
    const boundaries = new Set(input.boundaryParents);
    for (const id of boundaries) {
      number(id);
      if (ids.has(id)) invalid('Retained boundary');
    }
    const used = new Set<string>();
    for (const v of versions) {
      if (v.parent !== null) {
        if (number(v.parent) >= number(v.id)) invalid('Parent order');
        if (!ids.has(v.parent)) {
          if (!boundaries.has(v.parent)) invalid('Missing parent boundary');
          used.add(v.parent);
        }
      }
    }
    if (used.size !== boundaries.size) invalid('Unused boundary');
    const heads: Record<string, string | null> = Object.create(null) as Record<
      string,
      string | null
    >;
    const keys = Object.keys(input.heads);
    if (!keys.includes('main') || keys.length > Math.min(64, max)) invalid('Branch limit');
    for (const key of keys) {
      name(key);
      const head = input.heads[key];
      if (head !== null && (typeof head !== 'string' || !ids.has(head)))
        invalid('Missing branch head');
      heads[key] = head;
    }
    return {
      schema: 1,
      documentId,
      generation: input.generation,
      sequence: input.sequence,
      versions,
      heads,
      boundaryParents: [...boundaries],
    };
  }
  async function load(): Promise<{ expected: number | null; state: VersionState }> {
    const raw = await adapter.read();
    return raw === null
      ? { expected: null, state: empty() }
      : { expected: raw.generation, state: validate(raw) };
  }
  async function save(expected: number | null, state: VersionState): Promise<void> {
    if (expected !== null && expected >= Number.MAX_SAFE_INTEGER) invalid('Generation exhausted');
    state.generation = (expected ?? 0) + 1;
    const checked = validate(state);
    if (!(await adapter.compareAndSwap(expected, copy(checked))))
      throw new VersionStoreError('conflict', 'Adapter CAS failed; reload and retry explicitly');
  }
  return {
    read: async () => copy((await load()).state),
    async commit(branch, parent, input) {
      name(branch);
      const snap = snapshot(input, documentId);
      const { expected, state } = await load();
      if (!Object.hasOwn(state.heads, branch) || state.heads[branch] !== parent)
        throw new VersionStoreError('parent', 'Parent must equal branch head');
      if (state.sequence >= Number.MAX_SAFE_INTEGER) invalid('Version sequence exhausted');
      const version: DocumentVersion = {
        id: `v${++state.sequence}`,
        parent,
        branch,
        snapshot: snap,
      };
      state.versions.push(version);
      state.heads[branch] = version.id;
      const heads = new Set(Object.values(state.heads));
      while (state.versions.length > max) {
        const index = state.versions.findIndex((v) => !heads.has(v.id));
        if (index < 0)
          throw new VersionStoreError('capacity', 'All retained versions are branch heads');
        state.versions.splice(index, 1);
      }
      const ids = new Set(state.versions.map((v) => v.id));
      state.boundaryParents = [
        ...new Set(
          state.versions.flatMap((v) => (v.parent && !ids.has(v.parent) ? [v.parent] : [])),
        ),
      ];
      await save(expected, state);
      return Object.freeze({ ...version, snapshot: snap });
    },
    async branch(branch, from) {
      name(branch);
      const { expected, state } = await load();
      if (Object.hasOwn(state.heads, branch))
        throw new VersionStoreError('conflict', 'Branch exists');
      if (from !== null && !state.versions.some((v) => v.id === from))
        throw new VersionStoreError('parent', 'Branch source is not retained');
      state.heads[branch] = from;
      await save(expected, state);
    },
    async recover(input) {
      const next = validate(input),
        current = await adapter.read();
      const expected = current?.generation ?? null;
      if (
        current !== null &&
        (current.documentId !== documentId ||
          expected === null ||
          !Number.isSafeInteger(expected) ||
          expected < 0 ||
          !Number.isSafeInteger(current.sequence) ||
          current.sequence < 0)
      )
        invalid('Cannot recover without a valid adapter identity and generation');
      next.sequence = Math.max(next.sequence, current?.sequence ?? 0);
      await save(expected, next);
    },
  };
}
