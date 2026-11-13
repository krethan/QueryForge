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
  tilePos: null,
  ...extra,
});
const FIN = 'f0000000-0000-4000-8000-000000000001';
const TEAM = 'f0000000-0000-4000-8000-000000000002';
const READ = 'f0000000-0000-4000-8000-000000000003';
const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  name,
  createdAt: null,
  updatedAt: null,
  ownerId: 'u-me',
  ownerName: 'Me',
  access: 'OWNER',
  shared: false,
  reportIds: [],
  ...extra,
});

function setup(owned: Report[], shared: Report[], folders: Folder[]) {
  vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned, shared });
  const list = vi.spyOn(api, 'listFolders').mockResolvedValue(folders);
  const saveTiles = vi.spyOn(api, 'saveTileOrder').mockImplementation(async (ids) => ids);
  const saveFolder = vi.spyOn(api, 'saveFolderOrder').mockImplementation(async (id, reportIds) => ({
    ...folders.find((f) => f.id === id)!,
    reportIds,
  }));
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  return { list, saveTiles, saveFolder };
}
const sectionNamed = (name: string) =>
  screen
    .getByRole('heading', { level: 2, name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) })
    .closest('section')!;
const tileNames = (root: HTMLElement) =>
  within(root)
    .getAllByTestId('tile-slot')
    .map((el) => within(el).getByRole('heading', { level: 3 }).textContent);

const standard = () => {
  const owned = [rep('1', 'Revenue', { folderId: FIN }), rep('2', 'Costs')];
  const shared = [
    rep('3', 'Pipeline', { access: 'VIEWER', ownerName: 'Pat' }),
    rep('4', 'Forecast', { access: 'EDITOR', ownerName: 'Pat' }),
  ];
  const folders = [
    folder(FIN, 'Finance', { shared: true, reportIds: ['1'] }),
    folder(TEAM, 'Sales Team', {
      ownerId: 'u-pat',
      ownerName: 'Pat',
      access: 'EDITOR',
      shared: true,
      reportIds: ['4', '3', '2'],
    }),
    folder(READ, 'Board Pack', {
      ownerId: 'u-sam',
      ownerName: 'Sam',
      access: 'VIEWER',
      shared: true,
      reportIds: ['3', '4'],
    }),
  ];
  return { owned, shared, folders };
};

describe('Dashboard shared folders', { timeout: 20000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it('groups by shared folders using the server’s contents and order, with owner and role', async () => {
    const { owned, shared, folders } = standard();
    setup(owned, shared, folders);
    await screen.findAllByText('Revenue');
    fireEvent.click(screen.getByRole('switch', { name: /Group by folder/ }));
    const team = sectionNamed('Sales Team (Pat)');
    expect(tileNames(team)).toEqual(['Forecast', 'Pipeline', 'Costs']);
    expect(within(team).getByTestId('folder-sharing')).toHaveTextContent(
      'Shared folder Shared by Pat · Editor',
    );
    expect(within(sectionNamed('Finance')).getByTestId('folder-sharing')).toHaveTextContent(
      'Shared by you',
    );
    expect(tileNames(sectionNamed('Board Pack (Sam)'))).toEqual(['Pipeline', 'Forecast']);
    // Everything is in some folder, so there is no Unfiled section
    expect(screen.queryByRole('heading', { name: /^Unfiled/ })).not.toBeInTheDocument();
  });

  it('lists shared folders in the folder filter with their owner, and filters to one', async () => {
    const { owned, shared, folders } = standard();
    setup(owned, shared, folders);
    await screen.findAllByText('Revenue');
    const filter = screen.getByRole('combobox', { name: 'Folder' });
    expect(within(filter).getByRole('option', { name: 'Board Pack (Sam)' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: READ } });
    const section = sectionNamed('Board Pack (Sam)');
    expect(tileNames(section)).toEqual(['Pipeline', 'Forecast']);
    expect(screen.queryByText('Revenue')).not.toBeInTheDocument();
  });

  it('only lets editors rearrange a shared folder, and saves the folder order (not tile order)', async () => {
    const { owned, shared, folders } = standard();
    const { saveTiles, saveFolder, list } = setup(owned, shared, folders);
    await screen.findAllByText('Revenue');
    fireEvent.click(screen.getByRole('switch', { name: /Group by folder/ }));
    const board = sectionNamed('Board Pack (Sam)');
    expect(within(board).queryByRole('button', { name: /^Reorder / })).not.toBeInTheDocument();
    const team = sectionNamed('Sales Team (Pat)');
    fireEvent.keyDown(within(team).getByRole('button', { name: 'Reorder Costs' }), {
      key: 'Home',
    });
    expect(tileNames(sectionNamed('Sales Team (Pat)'))).toEqual(['Costs', 'Forecast', 'Pipeline']);
    await waitFor(() => expect(saveFolder).toHaveBeenCalledWith(TEAM, ['2', '4', '3']));
    expect(saveTiles).not.toHaveBeenCalled();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1)); // folders reloaded
  });

  it('offers editable shared folders in the move dialog and adds or removes there', async () => {
    const { owned, shared, folders } = standard();
    setup(owned, shared, folders);
    const add = vi.spyOn(api, 'addToFolder').mockResolvedValue(folders[1]);
    const remove = vi.spyOn(api, 'removeFromFolder').mockResolvedValue(folders[1]);
    const prefs = vi.spyOn(api, 'setReportPrefs');
    fireEvent.click(await screen.findByRole('button', { name: 'Move Revenue to a folder' }));
    let dialog = await screen.findByRole('dialog', { name: /Move "Revenue"/ });
    // own folders in the select (shared ones marked), editable shared folders as checkboxes
    expect(within(dialog).getByRole('option', { name: 'Finance (shared)' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /Sales Team/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Sales Team (Pat)' })).not.toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: /Board Pack/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Move' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Sales Team (Pat)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(TEAM, '1'));
    expect(prefs).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Move Costs to a folder' }));
    dialog = await screen.findByRole('dialog', { name: /Move "Costs"/ });
    const box = within(dialog).getByRole('checkbox', { name: 'Sales Team (Pat)' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(TEAM, '2'));
  });

  it('shares a folder from Manage folders and lists folders shared with you', async () => {
    const { owned, shared, folders } = standard();
    setup(owned, shared, folders);
    vi.spyOn(api, 'groups').mockResolvedValue(['finance']);
    const sharing = {
      shares: [{ type: 'GROUP' as const, id: 'finance', role: 'VIEWER' as const }],
      shareReports: null,
      reports: { included: [], skipped: [] },
    };
    const get = vi.spyOn(api, 'getFolderSharing').mockResolvedValue(sharing);
    const put = vi
      .spyOn(api, 'putFolderSharing')
      .mockImplementation(async (_id, s) => ({ ...sharing, shares: s }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage folders' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage folders' });
    const others = within(dialog).getByRole('list', { name: 'Folders shared with you' });
    expect(within(others).getByText('Sales Team')).toBeInTheDocument();
    expect(within(others).getByText(/Pat · Editor · 3 reports/)).toBeInTheDocument();
    // other people's folders cannot be renamed, deleted or shared from here
    expect(
      within(dialog).queryByRole('button', { name: 'Rename Sales Team' }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Share Sales Team' }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Share Finance' }));
    expect(await screen.findByText('Share folder "Finance"')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith(FIN));
    expect(
      screen.getByText(/Editors can also add, remove and reorder its reports/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Group: finance')).toBeInTheDocument();
    fireEvent.change(document.getElementById('role-0')!, { target: { value: 'EDITOR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        FIN,
        [expect.objectContaining({ type: 'GROUP', id: 'finance', role: 'EDITOR' })],
        null,
        true,
      ),
    );
  });

  it('warns that deleting a shared folder removes access but deletes no report', async () => {
    const { owned, shared, folders } = standard();
    setup(owned, shared, folders);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage folders' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage folders' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Finance' }));
    expect(
      within(dialog).getByText(
        /No report is deleted\. People it is shared with lose access to the folder\./,
      ),
    ).toBeInTheDocument();
  });

  it('keeps working with folder responses that have no sharing fields', async () => {
    setup(
      [rep('1', 'Revenue', { folderId: FIN }), rep('2', 'Loose')],
      [],
      [{ id: FIN, name: 'Finance', createdAt: null, updatedAt: null }],
    );
    await screen.findAllByText('Revenue');
    fireEvent.click(screen.getByRole('switch', { name: /Group by folder/ }));
    expect(tileNames(sectionNamed('Finance'))).toEqual(['Revenue']);
    expect(tileNames(sectionNamed('Unfiled'))).toEqual(['Loose']);
    expect(screen.queryByTestId('folder-sharing')).not.toBeInTheDocument();
  });
});
