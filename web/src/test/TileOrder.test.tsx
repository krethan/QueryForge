import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';
import {
  initialTileOrder,
  mergeSectionOrder,
  moveBefore,
  moveBy,
  sortByOrder,
} from '../utils/tileOrder';

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

function setup(owned: Report[], shared: Report[] = [], folders: Folder[] = []) {
  const list = vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned, shared });
  vi.spyOn(api, 'listFolders').mockResolvedValue(folders);
  const save = vi.spyOn(api, 'saveTileOrder').mockImplementation(async (ids) => ids);
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  return { list, save };
}
const tileNames = (root: HTMLElement = document.body) =>
  within(root)
    .getAllByTestId('tile-slot')
    .map((el) => within(el).getByRole('heading', { level: 3 }).textContent);
const slot = (name: string) =>
  screen
    .getAllByTestId('tile-slot')
    .find((el) => within(el).queryByRole('heading', { level: 3, name }))!;

describe('tile order helpers', () => {
  it('orders saved positions first, then the rest in loaded order', () => {
    expect(
      initialTileOrder([
        { id: 'a', tilePos: null },
        { id: 'b', tilePos: 1 },
        { id: 'c', tilePos: 0 },
        { id: 'd' },
      ]),
    ).toEqual(['c', 'b', 'a', 'd']);
  });
  it('moves within a section and merges back without moving other tiles', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveBefore(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    expect(moveBy(['a', 'b', 'c'], 'b', -5)).toEqual(['b', 'a', 'c']);
    // section [b, d] inside the whole order [a, b, c, d, e] becomes [d, b]
    expect(mergeSectionOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toEqual([
      'a',
      'd',
      'c',
      'b',
      'e',
    ]);
    expect(mergeSectionOrder(['a'], ['n', 'a'])).toEqual(['n', 'a']);
    expect(
      sortByOrder([{ id: 'x' }, { id: 'b' }, { id: 'a' }], ['a', 'b']).map((r) => r.id),
    ).toEqual(['a', 'b', 'x']);
  });
});

describe('Dashboard tile rearranging', { timeout: 20000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads in "My order" and shows tiles in the saved order, new reports last', async () => {
    const { list } = setup([
      rep('1', 'Alpha', { tilePos: 2 }),
      rep('2', 'Beta', { tilePos: 0 }),
      rep('3', 'Brand new'),
      rep('4', 'Gamma', { tilePos: 1 }),
    ]);
    await screen.findByText('Alpha');
    expect(list).toHaveBeenCalledWith({ search: '', sort: 'custom' });
    expect(tileNames()).toEqual(['Beta', 'Gamma', 'Alpha', 'Brand new']);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('custom');
    expect(screen.getByRole('button', { name: 'Reset order' })).toBeInTheDocument();
  });

  it('drags a tile before another and saves the whole order', async () => {
    const { save } = setup([rep('1', 'Alpha'), rep('2', 'Beta'), rep('3', 'Gamma')]);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();
    const dt = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(slot('Gamma'), { dataTransfer: dt });
    expect(slot('Gamma')).toHaveClass('qf-tile-slot--dragging');
    fireEvent.dragOver(slot('Alpha'), { dataTransfer: dt });
    expect(slot('Alpha')).toHaveClass('qf-tile-slot--drop-before');
    fireEvent.drop(slot('Alpha'), { dataTransfer: dt });
    expect(tileNames()).toEqual(['Gamma', 'Alpha', 'Beta']);
    await waitFor(() => expect(save).toHaveBeenCalledWith(['3', '1', '2']));
    expect(screen.getByTestId('reorder-status')).toHaveTextContent(
      'Gamma moved to position 1 of 3.',
    );
  });

  it('rearranges from the keyboard with the drag handle', async () => {
    const { save } = setup([rep('1', 'Alpha'), rep('2', 'Beta'), rep('3', 'Gamma')]);
    await screen.findByText('Alpha');
    const handle = screen.getByRole('button', { name: 'Reorder Alpha' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(tileNames()).toEqual(['Beta', 'Alpha', 'Gamma']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'End' });
    expect(tileNames()).toEqual(['Beta', 'Gamma', 'Alpha']);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(['2', '3', '1']));
    // saves run in order, so the last arrangement wins
    expect(save.mock.calls.map((c) => c[0])).toEqual([
      ['2', '1', '3'],
      ['2', '3', '1'],
    ]);
  });

  it('keeps owned and shared sections apart but saves one order across both', async () => {
    const { save } = setup(
      [rep('1', 'Mine A'), rep('2', 'Mine B')],
      [
        rep('3', 'Shared C', { access: 'VIEWER', ownerName: 'Pat' }),
        rep('4', 'Shared D', { access: 'EDITOR', ownerName: 'Pat' }),
      ],
    );
    await screen.findByText('Shared D');
    const sharedSection = screen
      .getByRole('heading', { name: 'Shared with me' })
      .closest('section')!;
    fireEvent.keyDown(within(sharedSection).getByRole('button', { name: 'Reorder Shared D' }), {
      key: 'ArrowLeft',
    });
    expect(tileNames(sharedSection)).toEqual(['Shared D', 'Shared C']);
    await waitFor(() => expect(save).toHaveBeenCalledWith(['1', '2', '4', '3']));
    // a tile dragged from another section cannot be dropped here
    const dt = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(slot('Mine A'), { dataTransfer: dt });
    fireEvent.drop(within(sharedSection).getAllByTestId('tile-slot')[0], { dataTransfer: dt });
    expect(tileNames(sharedSection)).toEqual(['Shared D', 'Shared C']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rearranging favorites or a folder only swaps those tiles in the whole order', async () => {
    const { save } = setup(
      [
        rep('1', 'A', { favorite: true }),
        rep('2', 'B', { folderId: FIN }),
        rep('3', 'C', { favorite: true, folderId: FIN }),
      ],
      [],
      [{ id: FIN, name: 'Finance', createdAt: null, updatedAt: null }],
    );
    await screen.findAllByText('A');
    const fav = screen.getByRole('heading', { name: /^Favorites/ }).closest('section')!;
    fireEvent.keyDown(within(fav).getByRole('button', { name: 'Reorder C' }), { key: 'ArrowUp' });
    await waitFor(() => expect(save).toHaveBeenCalledWith(['3', '2', '1']));
    expect(tileNames(fav)).toEqual(['C', 'A']);
  });

  it('does not offer rearranging for other sorts or while searching', async () => {
    setup([rep('1', 'Alpha'), rep('2', 'Beta')]);
    await screen.findByText('Alpha');
    expect(screen.getAllByRole('button', { name: /^Reorder / })).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'name' },
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Reorder / })).not.toBeInTheDocument(),
    );
    expect(slot('Alpha')).toHaveAttribute('draggable', 'false');
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search reports' }), {
      target: { value: 'Al' },
    });
    expect(await screen.findByText('Clear the search to rearrange tiles.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reorder / })).not.toBeInTheDocument();
  });

  it('puts the tiles back and shows the error when saving fails', async () => {
    setup([rep('1', 'Alpha'), rep('2', 'Beta')]);
    vi.mocked(api.saveTileOrder).mockRejectedValue(new Error('Order could not be saved'));
    await screen.findByText('Alpha');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Beta' }), { key: 'ArrowLeft' });
    expect(tileNames()).toEqual(['Beta', 'Alpha']);
    expect(await screen.findByText(/Order could not be saved/)).toBeInTheDocument();
    expect(tileNames()).toEqual(['Alpha', 'Beta']);
  });

  it('resets to the default order', async () => {
    const { list } = setup([rep('1', 'Alpha', { tilePos: 1 }), rep('2', 'Beta', { tilePos: 0 })]);
    const reset = vi.spyOn(api, 'resetTileOrder').mockResolvedValue([]);
    await screen.findByText('Alpha');
    expect(tileNames()).toEqual(['Beta', 'Alpha']);
    list.mockResolvedValue({ owned: [rep('1', 'Alpha'), rep('2', 'Beta')], shared: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset order' }));
    });
    expect(reset).toHaveBeenCalled();
    await waitFor(() => expect(tileNames()).toEqual(['Alpha', 'Beta']));
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();
  });
});
