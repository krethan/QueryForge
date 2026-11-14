import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';

const rep = (id: string, name: string, extra: Partial<Report> = {}): Report => ({
  id,
  name,
  description: null,
  category: null,
  sql: 'SELECT 1 FROM T',
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastExecutedAt: null,
  lastStatus: 'NEVER',
  lastRowCount: null,
  lastDurationMs: null,
  folderId: null,
  favorite: false,
  ...extra,
});
const folder = (id: string, name: string): Folder => ({
  id,
  name,
  createdAt: null,
  updatedAt: null,
});
const FIN = 'f0000000-0000-4000-8000-000000000001';
const OPS = 'f0000000-0000-4000-8000-000000000002';

function setup(
  owned: Report[],
  shared: Report[] = [],
  folders = [folder(FIN, 'Finance'), folder(OPS, 'Operations')],
  url = '/',
) {
  vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned, shared });
  vi.spyOn(api, 'listFolders').mockResolvedValue(folders);
  render(
    <MemoryRouter initialEntries={[url]}>
      <DashboardPage />
    </MemoryRouter>,
  );
}
const sectionNamed = (name: string) =>
  screen.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) }).closest('section')!;

describe('Dashboard folders and favorites', { timeout: 20000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows starred reports, owned or shared, in a Favorites section at the top', async () => {
    setup(
      [rep('1', 'Revenue', { favorite: true }), rep('2', 'Costs')],
      [rep('3', 'Pipeline', { favorite: true, access: 'VIEWER', ownerName: 'Pat' })],
    );
    await screen.findAllByText('Revenue');
    const fav = sectionNamed('Favorites');
    expect(within(fav).getByText('Revenue')).toBeInTheDocument();
    expect(within(fav).getByText('Pipeline')).toBeInTheDocument();
    expect(within(fav).queryByText('Costs')).not.toBeInTheDocument();
    // Favorites comes before everything else
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Favorites/);
  });

  it('opens on the folder named in the link from a notification (/?folder=<id>)', async () => {
    setup(
      [rep('1', 'Revenue', { folderId: FIN }), rep('2', 'Costs')],
      [],
      undefined,
      `/?folder=${OPS}`,
    );
    await waitFor(() => expect(screen.getByLabelText('Folder')).toHaveValue(OPS));
  });

  it('ignores a folder link it cannot show', async () => {
    setup([rep('1', 'Revenue')], [], undefined, '/?folder=not-mine');
    await screen.findAllByText('Revenue');
    expect(screen.getByLabelText('Folder')).toHaveValue('__all__');
  });

  it('stars and unstars a report through the API', async () => {
    setup([rep('1', 'Revenue')]);
    const spy = vi
      .spyOn(api, 'setReportPrefs')
      .mockResolvedValue({ folderId: null, favorite: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Star Revenue' }));
    expect(spy).toHaveBeenCalledWith('1', { favorite: true });
    expect(await screen.findByRole('heading', { name: /^Favorites/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Unstar Revenue' })[0]);
    expect(spy).toHaveBeenLastCalledWith('1', { favorite: false });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /^Favorites/ })).not.toBeInTheDocument(),
    );
  });

  it('rolls a star back when the server refuses it', async () => {
    setup([rep('1', 'Revenue')]);
    vi.spyOn(api, 'setReportPrefs').mockRejectedValue(new Error('Report not found.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Star Revenue' }));
    expect(await screen.findByText(/Report not found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Star Revenue' })).toBeInTheDocument();
  });

  it('filters by folder and by Unfiled', async () => {
    setup([
      rep('1', 'Revenue', { folderId: FIN }),
      rep('2', 'Costs', { folderId: FIN }),
      rep('3', 'Uptime', { folderId: OPS }),
      rep('4', 'Loose'),
    ]);
    await screen.findByText('Revenue');
    const filter = screen.getByLabelText('Folder');
    fireEvent.change(filter, { target: { value: FIN } });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Costs')).toBeInTheDocument();
    expect(screen.queryByText('Uptime')).not.toBeInTheDocument();
    expect(screen.queryByText('Loose')).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: '__unfiled__' } });
    expect(screen.getByText('Loose')).toBeInTheDocument();
    expect(screen.queryByText('Revenue')).not.toBeInTheDocument();
  });

  it('groups reports by folder with an Unfiled group, treating unknown folders as Unfiled', async () => {
    setup([
      rep('1', 'Revenue', { folderId: FIN }),
      rep('3', 'Uptime', { folderId: OPS }),
      rep('4', 'Loose'),
      rep('5', 'Orphan', { folderId: 'f0000000-0000-4000-8000-00000000dead' }),
    ]);
    await screen.findByText('Revenue');
    fireEvent.click(screen.getByRole('switch', { name: /Group by folder/ }));
    expect(within(sectionNamed('Finance')).getByText('Revenue')).toBeInTheDocument();
    expect(within(sectionNamed('Operations')).getByText('Uptime')).toBeInTheDocument();
    const unfiled = sectionNamed('Unfiled');
    expect(within(unfiled).getByText('Loose')).toBeInTheDocument();
    expect(within(unfiled).getByText('Orphan')).toBeInTheDocument();
  });

  it('moves a report into a folder', async () => {
    setup([rep('1', 'Revenue'), rep('2', 'Costs')]);
    const spy = vi
      .spyOn(api, 'setReportPrefs')
      .mockResolvedValue({ folderId: OPS, favorite: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Move Revenue to a folder' }));
    const dialog = await screen.findByRole('dialog', { name: /Move "Revenue"/ });
    fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: OPS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('1', { folderId: OPS }));
    fireEvent.change(screen.getAllByLabelText('Folder')[0], { target: { value: OPS } });
    await waitFor(() => expect(screen.queryByText('Costs')).not.toBeInTheDocument());
    expect(screen.getAllByText('Revenue').length).toBeGreaterThan(0);
  });

  it('creates, renames and deletes folders; deleting says reports move to Unfiled', async () => {
    setup([rep('1', 'Revenue', { folderId: FIN })]);
    const create = vi.spyOn(api, 'createFolder').mockResolvedValue(folder('n', 'Archive'));
    const rename = vi.spyOn(api, 'renameFolder').mockResolvedValue(folder(FIN, 'Money'));
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue({ moved: 1 });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage folders' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage folders' });
    fireEvent.change(within(dialog).getByLabelText('New folder name'), {
      target: { value: ' Archive ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Archive'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename Finance' }));
    const input = within(dialog).getByLabelText('Rename Finance');
    fireEvent.change(input, { target: { value: 'Money' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(FIN, 'Money'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Finance' }));
    expect(
      within(dialog).getByText(/1 report\(s\) move to Unfiled\. No report is deleted\./),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(FIN));
  });
});
