const { remember, forget, ensure } = require('../seedkit')

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
    const db = fakeDb([{ rows: [
      { table_name: 'spatial_planning.occupation_certificate', row_id: '9' },
      { table_name: 'spatial_planning.permit_application', row_id: '3' },
    ] }])
    await forget(db, 'TAG-A')
    expect(db.calls[0].text).toContain('ORDER BY id DESC')
    expect(db.calls[1].text).toContain('DELETE FROM spatial_planning.occupation_certificate')
    expect(db.calls[2].text).toContain('DELETE FROM spatial_planning.permit_application')
  })

  it('clears the ledger rows last', async () => {
    const db = fakeDb([{ rows: [{ table_name: 't', row_id: '1' }] }])
    await forget(db, 'TAG-A')
    expect(db.calls.at(-1).text).toContain('DELETE FROM public.seed_demo_ledger')
  })

  it('reports how many rows it removed', async () => {
    const db = fakeDb([
      { rows: [{ table_name: 't', row_id: '1' }] },
      { rowCount: 1 },
    ])
    expect(await forget(db, 'TAG-A')).toBe(1)
  })
})

describe('ensure', () => {
  it('inserts and remembers a row that does not exist yet', async () => {
    const db = fakeDb([
      { rows: [] },              // the existence check finds nothing
      { rows: [{ id: 'new-1' }] }, // the insert
    ])
    const id = await ensure(db, 'TAG-A', 'tbl', { a: 1, b: 2 }, 'a = $1', [1])
    expect(id).toBe('new-1')
    expect(db.calls[1].text).toContain('INSERT INTO tbl')
    expect(db.calls[1].params).toEqual([1, 2])
    expect(db.calls[2].text).toContain('seed_demo_ledger')
  })

  it('returns the existing id and inserts nothing on a re-run', async () => {
    const db = fakeDb([{ rows: [{ id: 'existing-9' }] }])
    const id = await ensure(db, 'TAG-A', 'tbl', { a: 1 }, 'a = $1', [1])
    expect(id).toBe('existing-9')
    expect(db.calls).toHaveLength(1)
    expect(db.calls.every(c => !c.text.includes('INSERT'))).toBe(true)
  })

  it('does not re-record an existing row in the ledger', async () => {
    // Otherwise --undo would delete a row this seed did not create.
    const db = fakeDb([{ rows: [{ id: 'existing-9' }] }])
    await ensure(db, 'TAG-A', 'tbl', { a: 1 }, 'a = $1', [1])
    expect(db.calls.some(c => c.text.includes('seed_demo_ledger'))).toBe(false)
  })
})
