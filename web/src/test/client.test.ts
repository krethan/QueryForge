import { api, ApiError } from '../api/client';

describe('api client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the CSRF token header on unsafe requests', async () => {
    document.cookie = 'qf_csrf=tok123';
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ report: { id: 'r' } }), { status: 201 }));
    await api.createReport({ name: 'x', sql: 'SELECT 1 FROM T' });
    const init = f.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok123');
    expect(init.credentials).toBe('same-origin');
  });

  it('maps server errors including SQLSTATE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'DB_ERROR', message: 'not found', sqlState: '42704', sqlCode: -204 },
        }),
        { status: 400 },
      ),
    );
    const e = await api.execute('SELECT * FROM X', 'id').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, sqlState: '42704', sqlCode: -204 });
  });

  it('downloads a folder audit CSV with the server-chosen UTF-8 file name', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('\uFEFF"Occurred at (UTC)"\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="Zo_ audit.csv"; filename*=UTF-8\'\'Zo%C3%AB%20audit.csv',
        },
      }),
    );
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const r = await api.exportFolderAudit('f1');
    expect(f.mock.calls[0][0]).toBe('/api/folders/f1/audit/export');
    expect(f.mock.calls[0][1]!.method).toBe('GET');
    expect(r.filename).toBe('Zoë audit.csv');
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('reports a refused export as an ApiError instead of saving a file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Only the owner' } }), {
        status: 403,
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const e = await api.exportFolderAudit('f1').catch((x) => x);
    expect(e).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(click).not.toHaveBeenCalled();
  });

  it('asks the admin-only endpoints for deleted folders', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ deletions: [], hasMore: false, limit: 50, offset: 0 })),
      );
    await api.listFolderDeletions(50);
    expect(f.mock.calls[0][0]).toBe('/api/admin/folder-deletions?limit=50&offset=50');
  });
});
