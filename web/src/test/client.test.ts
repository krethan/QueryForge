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
});
