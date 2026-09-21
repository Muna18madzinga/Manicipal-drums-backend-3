const { remember, forget, ensure, primaryKeyColumn, _resetPkCache } = require('../seedkit')

/** Records every query; returns queued results in order. */
function fakeDb (results = []) {
  const calls = []
  const queue = [...results]
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), params })
      return queue.length ? queue.shift() : { rows: [], rowCount: 1 }
    },
  }
}

describe('remember', () => {
  it('records the tag, table and id in the ledger', async () => {
    const db = fakeDb()
    await remember(db, 'TAG-A', 'spatial_planning.permit_event', 42)
    expect(db.calls[0].text).toContain('INSERT INTO public.seed_demo_ledger')
    expect(db.calls[0].params).toEqual(['TAG-A', 'spatial_planning.permit_event', '42'])
  })

  it('stores the id as text, so uuid and bigint keys both work', async () => {
    const db = fakeDb()
    await remember(db, 'TAG-A', 't', 7)
    expect(db.calls[0].params[2]).toBe('7')
  })

  it('tolerates being run twice', async () => {
    const db = fakeDb()
    await remember(db, 'TAG-A', 't', 1)
    expect(db.calls[0].text).toContain('ON CONFLICT DO NOTHING')
  })
})

describe('forget', () => {
  it('deletes newest first, so children go before their parents', async () => {
    const db = fakeDb([
      { rows: [
        { table_name: 'spatial_planning.occupation_certificate', row_id: '9' },
        { table_name: 'spatial_planning.permit_application', row_id: '3' },
      ] },
      PK_ID, { rowCount: 1 },
      PK_ID, { rowCount: 1 },
    ])
    await forget(db, 'TAG-A')
    const deletes = db.calls.filter(c => c.text.startsWith('DELETE FROM spatial_planning'))
    expect(db.calls[0].text).toContain('ORDER BY id DESC')
    expect(deletes[0].text).toContain('occupation_certificate')
    expect(deletes[1].text).toContain('permit_application')
  })

  it('clears the ledger rows last', async () => {
    const db = fakeDb([{ rows: [{ table_name: 't', row_id: '1' }] }, PK_ID, { rowCount: 1 }])
    await forget(db, 'TAG-A')
    expect(db.calls.at(-1).text).toContain('DELETE FROM public.seed_demo_ledger')
  })

  it('reports how many rows it removed', async () => {
    const db = fakeDb([
      { rows: [{ table_name: 't', row_id: '1' }] },
      PK_ID,
      { rowCount: 1 },
    ])
    expect(await forget(db, 'TAG-A')).toBe(1)
  })
})

// ensure() and forget() look the primary key up first; the cache is
// module-level, so it has to be cleared or one test's answer leaks to the next.
beforeEach(() => _resetPkCache())

/** A queued result representing "the primary key is `id`". */
const PK_ID = { rows: [{ attname: 'id' }] }

describe('ensure', () => {
  it('inserts and remembers a row that does not exist yet', async () => {
    const db = fakeDb([
      PK_ID,                    // the key lookup
      { rows: [] },             // the existence check finds nothing
      { rows: [{ k: 'new-1' }] }, // the insert
    ])
    const id = await ensure(db, 'TAG-A', 'tbl', { a: 1, b: 2 }, 'a = $1', [1])
    expect(id).toBe('new-1')
    expect(db.calls[2].text).toContain('INSERT INTO tbl')
    expect(db.calls[2].params).toEqual([1, 2])
    expect(db.calls[3].text).toContain('seed_demo_ledger')
  })

  it('returns the existing id and inserts nothing on a re-run', async () => {
    const db = fakeDb([PK_ID, { rows: [{ k: 'existing-9' }] }])
    const id = await ensure(db, 'TAG-A', 'tbl', { a: 1 }, 'a = $1', [1])
    expect(id).toBe('existing-9')
    expect(db.calls.every(c => !c.text.includes('INSERT'))).toBe(true)
  })

  it('does not re-record an existing row in the ledger', async () => {
    // Otherwise --undo would delete a row this seed did not create.
    const db = fakeDb([PK_ID, { rows: [{ k: 'existing-9' }] }])
    await ensure(db, 'TAG-A', 'tbl', { a: 1 }, 'a = $1', [1])
    expect(db.calls.some(c => c.text.includes('seed_demo_ledger'))).toBe(false)
  })
})

/*
 * seedkit originally hardcoded `WHERE id::text = $1`. public.site_content is
 * keyed on `slug`, so --undo died with "column id does not exist" and rolled
 * back the whole removal. These cover the key discovery that replaced it.
 */
describe('primaryKeyColumn', () => {
  it('uses the table\'s real primary key', async () => {
    const db = fakeDb([{ rows: [{ attname: 'slug' }] }])
    expect(await primaryKeyColumn(db, 'public.site_content_x')).toBe('slug')
  })

  it('defaults to id when the key is composite or absent', async () => {
    const db = fakeDb([{ rows: [{ attname: 'a' }, { attname: 'b' }] }])
    expect(await primaryKeyColumn(db, 'public.composite_x')).toBe('id')
  })

  it('assumes the public schema for an unqualified name', async () => {
    const db = fakeDb([{ rows: [{ attname: 'id' }] }])
    await primaryKeyColumn(db, 'bare_table_x')
    expect(db.calls[0].params).toEqual(['public', 'bare_table_x'])
  })

  it('deletes by the discovered key, not by id', async () => {
    const db = fakeDb([
      { rows: [{ table_name: 'public.site_content_y', row_id: 'about' }] },
      { rows: [{ attname: 'slug' }] },
      { rowCount: 1 },
    ])
    await forget(db, 'TAG-A')
    expect(db.calls[2].text).toContain('"slug"::text = $1')
    expect(db.calls[2].text).not.toContain('id::text')
  })
})
